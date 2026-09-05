import { useCallback, useEffect, useState } from 'react';
import type {
  Campaign,
  CampaignDetail,
  CampaignInput,
  CampaignPlanItemInput,
  CampaignSimulationResult,
  CampaignStatus,
  CampaignVariantInput,
  Draft,
  FacebookAccount,
  FacebookGroup
} from '@shared/types';

type Props = {
  onError: (error: unknown) => void;
  onNavigate?: (route: 'queue' | 'planner') => void;
};

export function CampaignsPage({ onError, onNavigate }: Props) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<CampaignDetail>();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Modals & Dialogs
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newCampaignInput, setNewCampaignInput] = useState<CampaignInput>({ name: '', description: '' });

  const [addVariantModalOpen, setAddVariantModalOpen] = useState(false);
  const [availableDrafts, setAvailableDrafts] = useState<Draft[]>([]);
  const [newVariantInput, setNewVariantInput] = useState<{ draftId: string; label: string }>({ draftId: '', label: '' });

  const [addTargetModalOpen, setAddTargetModalOpen] = useState(false);
  const [accounts, setAccounts] = useState<FacebookAccount[]>([]);
  const [groupsForAccount, setGroupsForAccount] = useState<FacebookGroup[]>([]);
  const [newTargetInput, setNewTargetInput] = useState<{ variantId: string; accountId: string; groupId: string; scheduledAt: string }>({
    variantId: '',
    accountId: '',
    groupId: '',
    scheduledAt: ''
  });

  const [simulation, setSimulation] = useState<CampaignSimulationResult>();
  const [simulating, setSimulating] = useState(false);
  const [confirmCommitOpen, setConfirmCommitOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitSuccess, setCommitSuccess] = useState(false);

  // Load campaigns
  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.campaignApi.list({
        search: search || undefined,
        status: statusFilter ? (statusFilter as CampaignStatus) : undefined
      });
      setCampaigns(list);
      if (selectedId && !list.some((c: Campaign) => c.id === selectedId)) {
        setSelectedId(list[0]?.id);
      } else if (!selectedId && list.length > 0) {
        setSelectedId(list[0].id);
      }
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [onError, search, statusFilter, selectedId]);

  // Load detail
  const loadDetail = useCallback(async (id: string) => {
    try {
      const c = await window.campaignApi.get(id);
      setDetail(c);
      setSimulation(undefined);
      setCommitSuccess(false);
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => {
    void loadCampaigns();
    const unsubscribe = window.campaignApi.onChanged(() => {
      void loadCampaigns();
      if (selectedId) {
        void loadDetail(selectedId);
      }
    });
    return unsubscribe;
  }, [loadCampaigns, loadDetail, selectedId]);

  useEffect(() => {
    if (selectedId) {
      void loadDetail(selectedId);
    } else {
      setDetail(undefined);
    }
  }, [selectedId, loadDetail]);

  // Create Campaign
  async function handleCreateCampaign() {
    if (!newCampaignInput.name.trim()) return;
    setSaving(true);
    try {
      const created = await window.campaignApi.create(newCampaignInput);
      setCreateModalOpen(false);
      setNewCampaignInput({ name: '', description: '' });
      await loadCampaigns();
      setSelectedId(created.id);
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  }

  // Transitions
  async function handleRequestReview() {
    if (!selectedId) return;
    try {
      const updated = await window.campaignApi.requestReview(selectedId);
      setDetail(updated);
      await loadCampaigns();
    } catch (e) {
      onError(e);
    }
  }

  async function handleRequestChanges() {
    if (!selectedId) return;
    try {
      const updated = await window.campaignApi.requestChanges(selectedId);
      setDetail(updated);
      await loadCampaigns();
    } catch (e) {
      onError(e);
    }
  }

  async function handleApprove() {
    if (!selectedId) return;
    try {
      const updated = await window.campaignApi.approve(selectedId);
      setDetail(updated);
      await loadCampaigns();
    } catch (e) {
      onError(e);
    }
  }

  async function handleArchive() {
    if (!selectedId) return;
    if (!window.confirm('Archive this campaign?')) return;
    try {
      const updated = await window.campaignApi.archive(selectedId);
      setDetail(updated);
      await loadCampaigns();
    } catch (e) {
      onError(e);
    }
  }

  async function handleDelete() {
    if (!selectedId || !detail) return;
    if (!window.confirm(`Delete campaign "${detail.name}"?`)) return;
    try {
      await window.campaignApi.delete(selectedId);
      setSelectedId(undefined);
      await loadCampaigns();
    } catch (e) {
      onError(e);
    }
  }

  // Variants modal open
  async function openAddVariantModal() {
    try {
      const drafts = await window.draftApi.list();
      setAvailableDrafts(drafts);
      setNewVariantInput({ draftId: drafts[0]?.id ?? '', label: `Variant ${String.fromCharCode(65 + (detail?.variants.length ?? 0))}` });
      setAddVariantModalOpen(true);
    } catch (e) {
      onError(e);
    }
  }

  async function handleAddVariant() {
    if (!selectedId || !newVariantInput.draftId) return;
    try {
      const input: CampaignVariantInput = {
        campaignId: selectedId,
        draftId: newVariantInput.draftId,
        label: newVariantInput.label.trim() || 'Variant'
      };
      await window.campaignApi.addVariant(input);
      setAddVariantModalOpen(false);
      await loadDetail(selectedId);
      await loadCampaigns();
    } catch (e) {
      onError(e);
    }
  }

  async function handleToggleVariant(variantId: string, currentEnabled: boolean) {
    if (!selectedId) return;
    try {
      await window.campaignApi.updateVariant({ variantId, enabled: !currentEnabled });
      await loadDetail(selectedId);
    } catch (e) {
      onError(e);
    }
  }

  async function handleDeleteVariant(variantId: string) {
    if (!selectedId || !window.confirm('Remove this variant and its planned targets?')) return;
    try {
      await window.campaignApi.deleteVariant(variantId);
      await loadDetail(selectedId);
      await loadCampaigns();
    } catch (e) {
      onError(e);
    }
  }

  // Plan target modal open
  async function openAddTargetModal() {
    if (!detail) return;
    try {
      const accList = await window.accountApi.list();
      setAccounts(accList);
      const firstAcc = accList[0];
      let firstGroups: FacebookGroup[] = [];
      if (firstAcc) {
        firstGroups = (await window.groupApi.accountGroups(firstAcc.id)).filter((g) => g.active);
      }
      setGroupsForAccount(firstGroups);

      const firstVariant = detail.variants.find((v) => v.enabled);
      setNewTargetInput({
        variantId: firstVariant?.id ?? '',
        accountId: firstAcc?.id ?? '',
        groupId: firstGroups[0]?.id ?? '',
        scheduledAt: ''
      });
      setAddTargetModalOpen(true);
    } catch (e) {
      onError(e);
    }
  }

  async function handleAccountChange(accountId: string) {
    try {
      const groups = (await window.groupApi.accountGroups(accountId)).filter((g) => g.active);
      setGroupsForAccount(groups);
      setNewTargetInput((prev) => ({
        ...prev,
        accountId,
        groupId: groups[0]?.id ?? ''
      }));
    } catch (e) {
      onError(e);
    }
  }

  async function handleAddPlanItem() {
    if (!selectedId || !newTargetInput.variantId || !newTargetInput.accountId || !newTargetInput.groupId) return;
    try {
      let isoScheduled: string | undefined;
      if (newTargetInput.scheduledAt) {
        isoScheduled = new Date(newTargetInput.scheduledAt).toISOString();
      }
      const input: CampaignPlanItemInput = {
        campaignId: selectedId,
        variantId: newTargetInput.variantId,
        accountId: newTargetInput.accountId,
        groupId: newTargetInput.groupId,
        scheduledAt: isoScheduled
      };
      await window.campaignApi.addPlanItem(input);
      setAddTargetModalOpen(false);
      await loadDetail(selectedId);
      await loadCampaigns();
    } catch (e) {
      onError(e);
    }
  }

  async function handleDeletePlanItem(planItemId: string) {
    if (!selectedId) return;
    try {
      await window.campaignApi.deletePlanItem(planItemId);
      await loadDetail(selectedId);
      await loadCampaigns();
    } catch (e) {
      onError(e);
    }
  }

  // Simulation
  async function handleSimulate() {
    if (!selectedId) return;
    setSimulating(true);
    try {
      await loadDetail(selectedId);
      const result = await window.campaignApi.simulate(selectedId);
      setSimulation(result);
    } catch (e) {
      onError(e);
    } finally {
      setSimulating(false);
    }
  }

  // Commit
  async function handleCommitToQueue() {
    if (!selectedId || !simulation?.freshnessToken) return;
    setCommitting(true);
    try {
      await window.campaignApi.commitToQueue({
        campaignId: selectedId,
        freshnessToken: simulation.freshnessToken
      });
      setConfirmCommitOpen(false);
      setCommitSuccess(true);
      await loadDetail(selectedId);
      await loadCampaigns();
    } catch (e) {
      onError(e);
    } finally {
      setCommitting(false);
    }
  }

  const isDraftState = detail?.status === 'DRAFT';
  const isInReview = detail?.status === 'IN_REVIEW';
  const isApproved = detail?.status === 'APPROVED';
  const isQueued = detail?.status === 'QUEUED';

  return (
    <main className="content drafts-page">
      <div className="page-heading">
        <div>
          <h2>Campaigns</h2>
          <p>Plan multi-target campaigns, content variants, and approvals. The Queue remains the publishing engine.</p>
        </div>
        <button className="primary" onClick={() => setCreateModalOpen(true)}>
          ＋ New campaign
        </button>
      </div>

      <div className="filters">
        <label>
          Search
          <input placeholder="Campaign name" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label>
          Status
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="IN_REVIEW">In Review</option>
            <option value="APPROVED">Approved</option>
            <option value="QUEUED">Queued</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </label>
      </div>

      <div className="split-pane">
        {/* Left List Pane */}
        <aside className="list-pane">
          {loading ? (
            <div className="muted-block">Loading campaigns…</div>
          ) : campaigns.length ? (
            campaigns.map((c) => (
              <button
                className={`list-item ${selectedId === c.id ? 'selected' : ''}`}
                key={c.id}
                onClick={() => setSelectedId(c.id)}
              >
                <strong>{c.name}</strong>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', margin: '4px 0' }}>
                  <span className={`status-badge status-${c.status.toLowerCase()}`}>{c.status}</span>
                  <small style={{ color: '#94a3b8' }}>
                    {c.variantCount} variant{c.variantCount !== 1 ? 's' : ''} · {c.planItemCount} target{c.planItemCount !== 1 ? 's' : ''}
                  </small>
                </div>
                <small>{new Date(c.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</small>
              </button>
            ))
          ) : (
            <div className="muted-block">No campaigns found.</div>
          )}
        </aside>

        {/* Right Editor / Detail Pane */}
        <section className="editor-pane">
          {detail ? (
            <>
              {/* Header */}
              <div className="editor-heading">
                <div>
                  <h3 style={{ margin: '0 0 6px 0', fontSize: '18px' }}>{detail.name}</h3>
                  {detail.description && <p style={{ margin: '0 0 4px 0', color: '#94a3b8', fontSize: '13px' }}>{detail.description}</p>}
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
                    <span className={`status-badge status-${detail.status.toLowerCase()}`}>{detail.status}</span>
                    {detail.status === 'APPROVED' && (
                      <span className={`status-badge status-${detail.freshness.toLowerCase()}`}>
                        {detail.freshness === 'CURRENT' ? 'Fresh Approval' : 'Approval Stale'}
                      </span>
                    )}
                    <small style={{ color: '#64748b' }}>
                      Updated {new Date(detail.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                    </small>
                  </div>
                </div>

                <div className="actions">
                  {isDraftState && (
                    <>
                      <button className="primary" onClick={() => void handleRequestReview()}>
                        Request Review
                      </button>
                      <button className="action-button" onClick={() => void handleArchive()}>
                        Archive
                      </button>
                      <button className="icon-button danger-text" onClick={() => void handleDelete()}>
                        Delete
                      </button>
                    </>
                  )}
                  {isInReview && (
                    <>
                      <button className="primary" onClick={() => void handleApprove()}>
                        Approve Campaign
                      </button>
                      <button className="action-button" onClick={() => void handleRequestChanges()}>
                        Request Changes
                      </button>
                      <button className="action-button" onClick={() => void handleArchive()}>
                        Archive
                      </button>
                    </>
                  )}
                  {isApproved && (
                    <>
                      <button
                        className="primary"
                        disabled={!simulation || simulation.status === 'BLOCKED' || detail.freshness !== 'CURRENT'}
                        onClick={() => setConfirmCommitOpen(true)}
                      >
                        Commit to Queue…
                      </button>
                      <button
                        className={detail.freshness === 'APPROVAL_STALE' ? 'action-button warning' : 'action-button'}
                        onClick={() => void handleRequestChanges()}
                        title="Reopen this campaign back to DRAFT to modify variants or targets"
                      >
                        {detail.freshness === 'APPROVAL_STALE' ? 'Reopen for Changes' : 'Request Changes'}
                      </button>
                      <button className="action-button" onClick={() => void handleArchive()}>
                        Archive
                      </button>
                    </>
                  )}
                  {isQueued && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button className="secondary" onClick={() => onNavigate?.('queue')}>
                        View in Queue
                      </button>
                      <button className="secondary" onClick={() => onNavigate?.('planner')}>
                        View in Planner
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {detail.status === 'APPROVED' && detail.freshness === 'APPROVAL_STALE' && (
                <div className="notice warning" style={{ margin: '12px 0' }}>
                  <strong>Approval Stale</strong>
                  <span>Underlying draft content or media has changed since approval. Reopen this campaign to review and re-approve before committing to the Queue.</span>
                  <div style={{ marginTop: '8px' }}>
                    <button className="primary" onClick={() => void handleRequestChanges()}>
                      Reopen for Changes
                    </button>
                  </div>
                </div>
              )}

              {commitSuccess && (
                <div className="notice success" style={{ margin: '12px 0' }}>
                  <strong>Campaign Committed to Queue!</strong>
                  <span>Queue items were created transactionally and are ready for publishing.</span>
                  <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
                    <button className="primary" onClick={() => onNavigate?.('queue')}>Go to Queue</button>
                    <button className="secondary" onClick={() => onNavigate?.('planner')}>Go to Planner</button>
                  </div>
                </div>
              )}

              {/* Section 1: Content Variants */}
              <div className="campaign-section">
                <div className="campaign-section-header">
                  <div>
                    <h4 style={{ margin: 0 }}>Content Variants ({detail.variants.length})</h4>
                    <small style={{ color: '#94a3b8' }}>Operator-defined content backed by existing Drafts.</small>
                  </div>
                  {isDraftState && (
                    <button className="secondary" onClick={() => void openAddVariantModal()}>
                      ＋ Add Variant
                    </button>
                  )}
                </div>

                {detail.variants.length ? (
                  <table className="campaign-table">
                    <thead>
                      <tr>
                        <th>Label</th>
                        <th>Draft Title</th>
                        <th>Draft Status</th>
                        <th>Approval Freshness</th>
                        <th>Enabled</th>
                        {isDraftState && <th>Action</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.variants.map((v) => (
                        <tr key={v.id}>
                          <td><strong>{v.label}</strong></td>
                          <td>{v.draftTitle}</td>
                          <td>
                            <span className={`status-badge status-${v.draftStatus.toLowerCase()}`}>{v.draftStatus}</span>
                          </td>
                          <td>
                            <span className={`status-badge status-${v.freshness.toLowerCase()}`}>
                              {v.freshness === 'CURRENT' ? 'CURRENT' : v.freshness === 'STALE' ? 'STALE' : 'NOT APPROVED'}
                            </span>
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={v.enabled}
                              disabled={!isDraftState}
                              onChange={() => void handleToggleVariant(v.id, v.enabled)}
                            />
                          </td>
                          {isDraftState && (
                            <td>
                              <button className="icon-button danger-text" onClick={() => void handleDeleteVariant(v.id)}>
                                Remove
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="muted-block">No variants attached. Add a draft variant to begin.</div>
                )}
              </div>

              {/* Section 2: Plan Targets */}
              <div className="campaign-section">
                <div className="campaign-section-header">
                  <div>
                    <h4 style={{ margin: 0 }}>Target Planning ({detail.planItems.length})</h4>
                    <small style={{ color: '#94a3b8' }}>Explicit account, group, and optional schedule assignments.</small>
                  </div>
                  {isDraftState && (
                    <button
                      className="secondary"
                      disabled={detail.variants.filter((v) => v.enabled).length === 0}
                      onClick={() => void openAddTargetModal()}
                    >
                      ＋ Add Target
                    </button>
                  )}
                </div>

                {detail.planItems.length ? (
                  <table className="campaign-table">
                    <thead>
                      <tr>
                        <th>Variant</th>
                        <th>Account</th>
                        <th>Group</th>
                        <th>Scheduled (UTC)</th>
                        {isDraftState && <th>Action</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.planItems.map((item) => (
                        <tr key={item.id}>
                          <td><strong>{item.variantLabel}</strong></td>
                          <td>{item.accountName}</td>
                          <td>{item.groupName}</td>
                          <td>
                            {item.scheduledAt ? (
                              new Date(item.scheduledAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
                            ) : (
                              <span style={{ color: '#64748b' }}>Manual (Immediate)</span>
                            )}
                          </td>
                          {isDraftState && (
                            <td>
                              <button className="icon-button danger-text" onClick={() => void handleDeletePlanItem(item.id)}>
                                Remove
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="muted-block">No target plan items added yet.</div>
                )}
              </div>

              {/* Section 3: Simulation */}
              <div className="campaign-section">
                <div className="campaign-section-header">
                  <div>
                    <h4 style={{ margin: 0 }}>Queue Simulation</h4>
                    <small style={{ color: '#94a3b8' }}>Read-only preview. Creates 0 queue rows, performs 0 Facebook actions.</small>
                  </div>
                  <button className="secondary" disabled={simulating} onClick={() => void handleSimulate()}>
                    {simulating ? 'Simulating…' : 'Simulate Campaign'}
                  </button>
                </div>

                {simulation ? (
                  <div className="simulation-box">
                    <div className="simulation-stats">
                      <div className="simulation-stat-pill">
                        <strong>Status: </strong>
                        <span className={`status-badge status-${simulation.status.toLowerCase()}`}>{simulation.status}</span>
                      </div>
                      <div className="simulation-stat-pill">
                        <strong>Planned Items: </strong> {simulation.plannedRows.length}
                      </div>
                      <div className="simulation-stat-pill">
                        <strong>Accounts: </strong> {simulation.accountCount}
                      </div>
                      <div className="simulation-stat-pill">
                        <strong>Groups: </strong> {simulation.groupCount}
                      </div>
                      <div className="simulation-stat-pill">
                        <strong>Scheduled: </strong> {simulation.scheduledCount}
                      </div>
                      <div className="simulation-stat-pill">
                        <strong>Manual: </strong> {simulation.unscheduledCount}
                      </div>
                    </div>

                    {simulation.blockers.length > 0 && (
                      <div className="notice error" style={{ margin: '8px 0' }}>
                        <strong>Blockers ({simulation.blockers.length}):</strong>
                        <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                          {simulation.blockers.map((b, idx) => (
                            <li key={idx}>
                              <strong>{b.code}: </strong> {b.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {simulation.warnings.length > 0 && (
                      <div className="notice warning" style={{ margin: '8px 0' }}>
                        <strong>Warnings ({simulation.warnings.length}):</strong>
                        <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                          {simulation.warnings.map((w, idx) => (
                            <li key={idx}>
                              <strong>{w.code}: </strong> {w.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {simulation.plannedRows.length > 0 && (
                      <div style={{ marginTop: '12px' }}>
                        <strong style={{ fontSize: '13px', color: '#cbd5e1' }}>Planned Queue Rows Preview:</strong>
                        <table className="campaign-table">
                          <thead>
                            <tr>
                              <th>Variant</th>
                              <th>Account</th>
                              <th>Group</th>
                              <th>Schedule</th>
                              <th>Media</th>
                            </tr>
                          </thead>
                          <tbody>
                            {simulation.plannedRows.map((row, idx) => (
                              <tr key={idx}>
                                <td>{row.variantLabel} ({row.draftTitle})</td>
                                <td>{row.accountName}</td>
                                <td>{row.groupName}</td>
                                <td>{row.scheduledAt ? new Date(row.scheduledAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'Manual'}</td>
                                <td>{row.mediaCount} file{row.mediaCount !== 1 ? 's' : ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="muted-block">Click &quot;Simulate Campaign&quot; to verify approval freshness and preview Queue materialization.</div>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <strong>Select a campaign</strong>
              <p>Create or select a campaign to plan variants, targets, and review.</p>
            </div>
          )}
        </section>
      </div>

      {/* Create Campaign Modal */}
      {createModalOpen && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>New Campaign</h3>
            <label>
              Campaign Name
              <input
                value={newCampaignInput.name}
                onChange={(e) => setNewCampaignInput({ ...newCampaignInput, name: e.target.value })}
                placeholder="e.g. Summer Promotion 2026"
                autoFocus
              />
            </label>
            <label>
              Description (Optional)
              <textarea
                value={newCampaignInput.description ?? ''}
                onChange={(e) => setNewCampaignInput({ ...newCampaignInput, description: e.target.value })}
                placeholder="Campaign goals and operator notes"
                rows={3}
              />
            </label>
            <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
              <button className="action-button" onClick={() => setCreateModalOpen(false)}>
                Cancel
              </button>
              <button className="primary" disabled={saving || !newCampaignInput.name.trim()} onClick={() => void handleCreateCampaign()}>
                {saving ? 'Creating…' : 'Create Campaign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Variant Modal */}
      {addVariantModalOpen && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>Add Content Variant</h3>
            <label>
              Variant Label
              <input
                value={newVariantInput.label}
                onChange={(e) => setNewVariantInput({ ...newVariantInput, label: e.target.value })}
                placeholder="e.g. Variant A (Discount focus)"
              />
            </label>
            <label>
              Select Existing Draft
              <select
                value={newVariantInput.draftId}
                onChange={(e) => setNewVariantInput({ ...newVariantInput, draftId: e.target.value })}
              >
                {availableDrafts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title} ({d.status})
                  </option>
                ))}
              </select>
            </label>
            <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
              <button className="action-button" onClick={() => setAddVariantModalOpen(false)}>
                Cancel
              </button>
              <button className="primary" disabled={!newVariantInput.draftId} onClick={() => void handleAddVariant()}>
                Add Variant
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Target Modal */}
      {addTargetModalOpen && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>Add Plan Target</h3>
            <label>
              Select Variant
              <select
                value={newTargetInput.variantId}
                onChange={(e) => setNewTargetInput({ ...newTargetInput, variantId: e.target.value })}
              >
                {detail?.variants.filter((v) => v.enabled).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} ({v.draftTitle})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Select Account
              <select
                value={newTargetInput.accountId}
                onChange={(e) => void handleAccountChange(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.status})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Select Assigned Group
              <select
                value={newTargetInput.groupId}
                onChange={(e) => setNewTargetInput({ ...newTargetInput, groupId: e.target.value })}
              >
                {groupsForAccount.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Scheduled Time (Optional, leave blank for Manual)
              <input
                type="datetime-local"
                value={newTargetInput.scheduledAt}
                onChange={(e) => setNewTargetInput({ ...newTargetInput, scheduledAt: e.target.value })}
              />
            </label>
            <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
              <button className="action-button" onClick={() => setAddTargetModalOpen(false)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!newTargetInput.variantId || !newTargetInput.accountId || !newTargetInput.groupId}
                onClick={() => void handleAddPlanItem()}
              >
                Add Target
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Commit Modal */}
      {confirmCommitOpen && simulation && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>Confirm Commit to Queue</h3>
            <p>
              Materializing this campaign will create <strong>{simulation.plannedRows.length}</strong> immutable Queue item(s) across{' '}
              <strong>{simulation.accountCount}</strong> account(s) and <strong>{simulation.groupCount}</strong> group(s).
            </p>
            <div className="simulation-stats" style={{ margin: '12px 0' }}>
              <div className="simulation-stat-pill">Scheduled items: {simulation.scheduledCount}</div>
              <div className="simulation-stat-pill">Manual items: {simulation.unscheduledCount}</div>
            </div>
            <p style={{ fontSize: '13px', color: '#94a3b8' }}>
              This operation is atomic and transaction-protected. The campaign will transition to QUEUED.
            </p>
            <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
              <button className="action-button" onClick={() => setConfirmCommitOpen(false)}>
                Cancel
              </button>
              <button className="primary" disabled={committing} onClick={() => void handleCommitToQueue()}>
                {committing ? 'Committing…' : 'Confirm & Commit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

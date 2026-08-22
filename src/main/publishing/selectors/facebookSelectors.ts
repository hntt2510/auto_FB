export const FACEBOOK_SELECTORS_VERSION = '2026-08-v1';

export const facebookText = {
  composerTrigger: /write something|create post|what(?:'|’)s on your mind|viết gì đó|tạo bài viết|bạn đang nghĩ gì/i,
  composerTextbox: /what(?:'|’)s on your mind|write something|create a public post|bạn đang nghĩ gì|viết gì đó/i,
  postButton: /^(post|publish|đăng|đăng bài)$/i,
  uploadBusy: /uploading|processing|preparing|đang tải|đang xử lý|đang chuẩn bị/i,
  pendingApproval: /pending approval|awaiting approval|submitted for approval|chờ phê duyệt|đang chờ duyệt/i,
  accepted: /post submitted|your post was shared|post created|đã gửi bài viết|bài viết đã được đăng/i,
  permissionDenied: /cannot post|can't post|not a member|posting is disabled|group unavailable|không thể đăng|không phải thành viên|nhóm không khả dụng/i
} as const;

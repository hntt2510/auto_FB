export const FACEBOOK_SELECTORS_VERSION = '2026-08-v2';

export const facebookText = {
  composerTrigger: /write something|create post|what(?:'|\u2019)s on your mind|create a public post|vi\u1ebft g\u00ec \u0111\u00f3|vi\u1ebft g\u00ec \u0111i|b\u1ea1n \u0111ang ngh\u0129 g\u00ec|b\u1ea1n vi\u1ebft g\u00ec \u0111i|b\u1ea1n mu\u1ed1n chia s\u1ebb g\u00ec|chia s\u1ebb g\u00ec \u0111\u00f3|t\u1ea1o b\u00e0i vi\u1ebft|t\u1ea1o b\u00e0i vi\u1ebft c\u00f4ng khai/i,
  composerTextbox: /what(?:'|\u2019)s on your mind|write something|create a public post|b\u1ea1n \u0111ang ngh\u0129 g\u00ec|vi\u1ebft g\u00ec \u0111\u00f3|vi\u1ebft g\u00ec \u0111i/i,
  postButton: /^(post|publish|\u0111\u0103ng|\u0111\u0103ng b\u00e0i)$/i,
  uploadBusy: /uploading|processing|preparing|\u0111ang t\u1ea3i|\u0111ang x\u1eed l\u00fd|\u0111ang chu\u1ea9n b\u1ecb/i,
  pendingApproval: /pending approval|awaiting approval|submitted for approval|ch\u1edd ph\u00ea duy\u1ec7t|\u0111ang ch\u1edd duy\u1ec7t/i,
  accepted: /post submitted|your post was shared|post created|\u0111\u00e3 g\u1eedi b\u00e0i vi\u1ebft|b\u00e0i vi\u1ebft \u0111\u00e3 \u0111\u01b0\u1ee3c \u0111\u0103ng/i,
  permissionDenied: /cannot post|can't post|not a member|posting is disabled|group unavailable|kh\u00f4ng th\u1ec3 \u0111\u0103ng|kh\u00f4ng ph\u1ea3i th\u00e0nh vi\u00ean|nh\u00f3m kh\u00f4ng kh\u1ea3 d\u1ee5ng/i
} as const;

// Configuration
var CONFIG = {
  API_BASE_URL: "/api",
  // WebSocket to same origin FastAPI server
  WS_URL: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
  USE_WS: true,
  USE_POLL: true,
  POLL_MS: 9000,
  // Authentication is now handled via session cookies (msgdrop_sess)
  // No PIN required in the frontend - authentication happens at /unlock
  REACTION_EMOJIS: ['👍','👎','❤️','😂','😮','😢','🔥']
};

export { WhatsAppBridge } from './bridge.js';

export default {
  async fetch(request, env, ctx) {
    const id = env.BRIDGE.idFromName('main');
    const stub = env.BRIDGE.get(id);
    return stub.fetch(request);
  },
};

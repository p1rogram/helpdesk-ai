// AI: Cloudflare Worker that forwards Telegram Bot API calls. Needed when the server cannot reach
// api.telegram.org directly (hosting in Russia). Deploy: dash.cloudflare.com -> Workers -> Create ->
// paste this file -> Deploy; put the worker URL into TELEGRAM_API_ROOT on the server.
// Only /bot<token>/<method> paths are forwarded, nothing is logged or stored.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/bot')) return new Response('not found', { status: 404 });
    const upstream = new URL(url.pathname + url.search, 'https://api.telegram.org');
    const init = {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'follow',
    };
    return fetch(upstream, init);
  },
};

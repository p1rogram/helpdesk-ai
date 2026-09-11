// AI: Cloudflare Worker, пробрасывающий вызовы Telegram Bot API. Нужен, когда сервер не достаёт до
// api.telegram.org напрямую (хостинг в России). Развернуть: dash.cloudflare.com -> Workers ->
// Create -> вставить этот файл -> Deploy; URL worker-а записать в TELEGRAM_API_ROOT на сервере.
// Пробрасываются только пути /bot<token>/<method>, ничего не логируется и не хранится.
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

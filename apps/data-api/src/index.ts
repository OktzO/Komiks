export default {
  async fetch(request: Request): Promise<Response> {
    return new Response(JSON.stringify({ status: 'ok', service: 'manga-data-api' }), {
      headers: { 'content-type': 'application/json' }
    });
  }
};

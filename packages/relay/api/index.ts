export const config = { runtime: 'edge' };
export default function handler(): Response {
  return new Response('kicad-part-relay ok', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

import { handleEasyedaComponent } from '../../src/index';
export const config = { runtime: 'edge' };
export default function handler(req: Request): Promise<Response> { return handleEasyedaComponent(new URL(req.url)); }

import { handleEasyedaModelObj } from '../../src/index';
export const config = { runtime: 'edge' };
export default function handler(req: Request): Promise<Response> { return handleEasyedaModelObj(new URL(req.url)); }

import { z } from 'zod';
export const env = z.object({
	PSB_STABLE_URL: z.string().url().default('https://audiobookshelf.felixfoertsch.de'),
	PSB_STABLE_USERNAME: z.string().min(1),
	PSB_STABLE_PASSWORD: z.string().min(1),
	PSB_ALLOWED_ORIGINS: z.string().default('').transform(value => value.split(',').map(origin => origin.trim()).filter(Boolean)).pipe(z.array(z.string().url().refine(origin => { try { return new URL(origin).origin === origin; } catch { return false; } }, 'expected exact origin without path'))),
	PSB_DATA_DIR: z.string().default('/data'),
	PSB_SCHEDULER_ENABLED: z.enum(['0', '1']).default('0'),
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),
	AD_ANALYSIS_PROXY_URL: z.string().url().optional(),
}).parse(process.env);

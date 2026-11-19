import { z } from 'zod';

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3000),
    API_KEY: z.string().min(1, 'API_KEY é obrigatória'),
    GITHUB_TOKEN: z.string().min(1, 'GITHUB_TOKEN é obrigatório'),
    GIT_PEM_PATH: z.string().min(1, 'Caminho do arquivo .pem é obrigatório'),
    CLONE_DEST_DIR: z.string().default('./repos'),
});

export const env = envSchema.parse(process.env);

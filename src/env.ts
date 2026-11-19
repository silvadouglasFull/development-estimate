import { z } from 'zod';

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3000),
    API_KEY: z.string().min(1, 'API_KEY é obrigatória'),
    GITHUB_TOKEN: z.string().min(1, 'GITHUB_TOKEN é obrigatório'),
    GITHUB_HOST: z.string().min(1, 'GITHUB_HOST é obrigatório'),
    GIT_PEM_PATH: z.string().min(1, 'Caminho do arquivo .pem é obrigatório'),
    CLONE_DEST_DIR: z.string().default('./repos'),
});
export function loadEnv() {
    return envSchema.parse(process.env);
}

export const env = process.env.NODE_ENV === 'test'
    ? (envSchema.safeParse(process.env).success ? envSchema.safeParse(process.env).data! : ({} as z.infer<typeof envSchema>))
    : envSchema.parse(process.env);
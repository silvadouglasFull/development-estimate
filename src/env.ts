import { z } from 'zod';


const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(3000),
    API_KEY: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_HOST: z.string().default('github.com'),
    GIT_PEM_PATH: z.string().min(1),
    CLONE_DEST_DIR: z.string().default('./repos'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default('gpt-4o-mini'),
});

export const env = envSchema.parse(process.env);
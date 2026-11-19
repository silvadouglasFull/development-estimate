import type { Config } from 'jest';

const config: Config = {
    clearMocks: true,
    coverageProvider: 'v8',
    testEnvironment: 'node',
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
    },
    transform: {
        '^.+\\.(t|j)sx?$': [
            '@swc/jest',
            {
                jsc: {
                    parser: {
                        syntax: 'typescript',
                    },
                    target: 'es2022',
                },
            },
        ],
    },
};

export default config;

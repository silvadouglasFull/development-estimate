import { selectRepositories } from '@/cli/prompt';
import { env } from '@/env';
import { GitWorkHourEstimatorService } from '@/services/git-work-hour.service';
import { GitService } from '@/services/git.service';
import { GitHubService } from '@/services/github.service';
import {
    type AnalyzedProjectInput,
    LlmEstimatorAnalysisService,
} from '@/services/llm-estimator-analysis.service';
import { ExitPromptError } from '@inquirer/core';
import { confirm, input, select } from '@inquirer/prompts';
import { basename, resolve } from 'node:path';

/**
 * Output mode chosen by the user for displaying or saving repository hour estimates.
 */
type EstimateOutputMode = 'markdown' | 'console';

/**
 * Stores the chosen branch alongside each processed repository URL.
 */
type RepoBranchSelection = {
    repoUrl: string;
    repoName: string;
    branch: string;
};

/**
 * Extracts the local repository directory name from a repository URL.
 */
function resolveRepoFolderName(repoUrl: string): string {
    // Step 1: Strip trailing .git and extract the last path or SCP-style segment.
    const cleanUrl = repoUrl.split('/').pop() ?? repoUrl;
    const repoPart = cleanUrl.split(':').pop() ?? cleanUrl;
    return basename(repoPart, '.git');
}

/**
 * Lists branches for a repository via GitService and prompts the user to choose one.
 */
async function promptBranchForRepository(
    gitService: GitService,
    repoUrl: string,
    repoName: string
): Promise<string> {
    // Step 2: List available branches for this repository.
    const branches = await gitService.listBranches(repoUrl);
    const options = branches.length > 0 ? branches : ['main'];
    const defaultBranch = options.includes('main') ? 'main' : options[0];

    // Step 3: Ask the user which branch to use for this specific repository.
    return select<string>({
        message: `Qual branch você deseja usar para o repositório "${repoName}"?`,
        choices: options.map((branch) => ({
            name: branch,
            value: branch,
        })),
        default: defaultBranch,
    });
}

/**
 * Main CLI orchestration function that lists GitHub repositories, lists branches and
 * prompts per repository, clones/updates them, generates estimates, and runs a single
 * consolidated LLM analysis across all analyzed projects when requested.
 */
async function main() {
    // Step 4: Instantiate GitHub, Git, work-hour estimator, and LLM analysis services.
    const githubService = new GitHubService();
    const gitService = new GitService();
    const estimatorService = new GitWorkHourEstimatorService();
    const llmAnalysisService = new LlmEstimatorAnalysisService();

    // Step 5: Fetch repositories from GitHub and stop early if none are found.
    console.log('Buscando repositórios no GitHub...');
    const repositories = await githubService.listRepositories();

    if (repositories.length === 0) {
        console.log('Nenhum repositório encontrado.');
        return;
    }

    // Step 6: Prompt the user to select repositories to work with.
    const selectedUrls = await selectRepositories(repositories);

    if (selectedUrls.length === 0) {
        console.log('Nenhum repositório selecionado.');
        return;
    }

    // Step 7: Ensure destination folder exists and ask branch per repository as we go.
    await gitService.ensureDestinationExists();
    const processedRepos: RepoBranchSelection[] = [];

    for (const repoUrl of selectedUrls) {
        const repoName = resolveRepoFolderName(repoUrl);
        console.log(`\nListando branches de "${repoName}"...`);

        try {
            const chosenBranch = await promptBranchForRepository(gitService, repoUrl, repoName);
            console.log(`Clonando/atualizando "${repoName}" na branch "${chosenBranch}"...`);

            await gitService.cloneShallow(repoUrl, chosenBranch);
            processedRepos.push({ repoUrl, repoName, branch: chosenBranch });
            console.log(`Concluído: ${repoName} (${chosenBranch})`);
        } catch (error) {
            console.error(`Erro ao processar ${repoName}:`, error);
        }
    }

    if (processedRepos.length === 0) {
        console.log('\nNenhum repositório foi processado com sucesso para estimativa.');
        return;
    }

    // Step 8: Ask whether to run hour estimates now that repositories are ready.
    const shouldEstimate = await confirm({
        message: 'Deseja realizar as estimativas agora? (Y/N)',
        default: false,
    });

    // Step 9: If the user answers N (false), say goodbye and exit cleanly.
    if (!shouldEstimate) {
        console.log('\nTudo certo! Até a próxima e bom código!');
        process.exitCode = 0;
        return;
    }

    // Step 10: Ask whether the user wants a .md file per repository or the object in console.
    const outputMode = await select<EstimateOutputMode>({
        message: 'Como você deseja visualizar/gerar as estimativas de cada repositório?',
        choices: [
            {
                name: 'Gerar um arquivo .md para cada repositório (estimate/NOME_REPOSITORIO)',
                value: 'markdown',
            },
            {
                name: 'Exibir no console do terminal o objeto com as estimativas',
                value: 'console',
            },
        ],
    });

    // Step 11: Ask whether the LLM should perform a consolidated analysis; if yes, ask goal and details.
    const shouldRunLlmAnalysis = await confirm({
        message: 'Deseja que o LLM faça uma análise sobre essas estimativas? (Y/N)',
        default: false,
    });

    let userGoalAndDetails = '';
    if (shouldRunLlmAnalysis) {
        userGoalAndDetails = await input({
            message:
                'Qual o objetivo da análise? (Ex.: você quer criar um novo projeto e estimar quanto cobrar ou quanto tempo levaria para executar esse projeto? Se sim, me fale sobre o projeto e dê o maior número de detalhes):',
            validate: (value) =>
                value.trim().length > 0 || 'Por favor, informe o objetivo e os detalhes do projeto.',
        });
    }

    // Step 12: Generate estimation.md for each repository and collect inputs for consolidated LLM analysis.
    const baseCloneDir = resolve(env.CLONE_DEST_DIR);
    const analyzedProjects: AnalyzedProjectInput[] = [];

    for (const repo of processedRepos) {
        const repoDir = resolve(baseCloneDir, repo.repoName);
        const filters = { branch: repo.branch };

        try {
            if (outputMode === 'markdown') {
                const { filePath } = await estimatorService.estimateAndSaveMarkdown(repoDir, filters);
                console.log(
                    `Arquivo .md gerado para ${repo.repoName} (branch: ${repo.branch}): ${filePath}`
                );
                analyzedProjects.push({
                    projectName: repo.repoName,
                    repoDir,
                    estimateMarkdownPath: filePath,
                });
            } else {
                const metrics = await estimatorService.estimateFromRepository(repoDir, filters);
                console.log(`\nEstimativas para ${repo.repoName} (branch: ${repo.branch}):`);
                console.dir(metrics, { depth: null });

                if (shouldRunLlmAnalysis) {
                    const savedEstimatePath = await estimatorService.saveEstimateMarkdown(
                        repoDir,
                        metrics
                    );
                    analyzedProjects.push({
                        projectName: repo.repoName,
                        repoDir,
                        estimateMarkdownPath: savedEstimatePath,
                    });
                }
            }
        } catch (error) {
            console.error(`Erro ao processar ${repo.repoName}:`, error);
        }
    }

    // Step 13: Run a single consolidated LLM analysis across all analyzed projects when requested.
    if (shouldRunLlmAnalysis && analyzedProjects.length > 0) {
        console.log('\nGerando análise consolidada com LLM para o projeto informado...');
        const consolidatedAnalysisPath = await llmAnalysisService.generateConsolidatedAnalysis({
            projects: analyzedProjects,
            userGoalAndDetails,
        });
        console.log(`Análise consolidada salva em: ${consolidatedAnalysisPath}`);
    }
}

main().catch((error: unknown) => {
    if (error instanceof ExitPromptError) {
        console.log('Encerrado.');
        process.exitCode = 0;
        return;
    }

    console.error(error);
    process.exitCode = 1;
});
import { selectRepositories } from '@/cli/prompt';
import { env } from '@/env';
import { GitWorkHourEstimatorService } from '@/services/git-work-hour.service';
import { GitService } from '@/services/git.service';
import { GitHubService } from '@/services/github.service';
import { ExitPromptError } from '@inquirer/core';
import { confirm, select } from '@inquirer/prompts';
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
    // Step 1: List available branches for this repository.
    const branches = await gitService.listBranches(repoUrl);
    const options = branches.length > 0 ? branches : ['main'];
    const defaultBranch = options.includes('main') ? 'main' : options[0];

    // Step 2: Ask the user which branch to use for this specific repository.
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
 * prompts per repository, clones/updates them, and optionally generates estimates.
 */
async function main() {
    // Step 3: Instantiate GitHub, Git, and work-hour estimator services.
    const githubService = new GitHubService();
    const gitService = new GitService();
    const estimatorService = new GitWorkHourEstimatorService();

    // Step 4: Fetch repositories from GitHub and stop early if none are found.
    console.log('Buscando repositórios no GitHub...');
    const repositories = await githubService.listRepositories();

    if (repositories.length === 0) {
        console.log('Nenhum repositório encontrado.');
        return;
    }

    // Step 5: Prompt the user to select repositories to work with.
    const selectedUrls = await selectRepositories(repositories);

    if (selectedUrls.length === 0) {
        console.log('Nenhum repositório selecionado.');
        return;
    }

    // Step 6: Ensure destination folder exists and ask branch per repository as we go.
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

    // Step 7: Ask whether to run hour estimates now that repositories are ready.
    const shouldEstimate = await confirm({
        message: 'Deseja realizar as estimativas agora? (Y/N)',
        default: false,
    });

    // Step 8: If the user answers N (false), say goodbye and exit cleanly.
    if (!shouldEstimate) {
        console.log('\nTudo certo! Até a próxima e bom código!');
        process.exitCode = 0;
        return;
    }

    // Step 9: Ask whether the user wants a .md file per repository or the object in console.
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

    // Step 10: Run estimation for each repository using the branch chosen for that repository.
    const baseCloneDir = resolve(env.CLONE_DEST_DIR);

    for (const repo of processedRepos) {
        const repoDir = resolve(baseCloneDir, repo.repoName);
        const filters = { branch: repo.branch };

        try {
            if (outputMode === 'markdown') {
                const { filePath } = await estimatorService.estimateAndSaveMarkdown(repoDir, filters);
                console.log(`Arquivo .md gerado para ${repo.repoName} (branch: ${repo.branch}): ${filePath}`);
            } else {
                const metrics = await estimatorService.estimateFromRepository(repoDir, filters);
                console.log(`\nEstimativas para ${repo.repoName} (branch: ${repo.branch}):`);
                console.dir(metrics, { depth: null });
            }
        } catch (error) {
            console.error(`Erro ao estimar ${repo.repoName}:`, error);
        }
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
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
 * Extracts the local repository directory name from a repository URL.
 */
function resolveRepoFolderName(repoUrl: string): string {
    const cleanUrl = repoUrl.split('/').pop() ?? repoUrl;
    const repoPart = cleanUrl.split(':').pop() ?? cleanUrl;
    return basename(repoPart, '.git');
}

/**
 * Main CLI orchestration function that lists GitHub repositories, clones selected ones
 * shallowly, and optionally generates Markdown reports or prints estimation objects.
 */
async function main() {
    // Step 1: Instantiate GitHub, Git, and work-hour estimator services.
    const githubService = new GitHubService();
    const gitService = new GitService();
    const estimatorService = new GitWorkHourEstimatorService();

    // Step 2: Fetch repositories from GitHub and stop early if none are found.
    console.log('Buscando repositórios no GitHub...');
    const repositories = await githubService.listRepositories();

    if (repositories.length === 0) {
        console.log('Nenhum repositório encontrado.');
        return;
    }

    // Step 3: Prompt the user to select repositories to clone.
    const selectedUrls = await selectRepositories(repositories);

    if (selectedUrls.length === 0) {
        console.log('Nenhum repositório selecionado.');
        return;
    }

    // Step 4: Ensure destination folder exists and clone each selected repository.
    await gitService.ensureDestinationExists();
    const clonedUrls: string[] = [];

    for (const repoUrl of selectedUrls) {
        console.log(`\nClonando: ${repoUrl}...`);

        try {
            await gitService.cloneShallow(repoUrl);
            clonedUrls.push(repoUrl);
            console.log(`Concluído: ${repoUrl}`);
        } catch (error) {
            console.error(`Erro ao clonar ${repoUrl}:`, error);
        }
    }

    if (clonedUrls.length === 0) {
        console.log('\nNenhum repositório foi clonado com sucesso para estimativa.');
        return;
    }

    // Step 5: Ask whether to run hour estimates now that cloning has finished.
    const shouldEstimate = await confirm({
        message: 'Deseja realizar as estimativas agora que os repositórios foram clonados? (Y/N)',
        default: false,
    });

    // Step 6: If the user answers N (false), say goodbye and exit cleanly.
    if (!shouldEstimate) {
        console.log('\nTudo certo! Até a próxima e bom código!');
        process.exitCode = 0;
        return;
    }

    // Step 7: Ask whether the user wants a .md file per repository or the object in console.
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

    // Step 8: Run estimation for each cloned repository in the chosen output format.
    const baseCloneDir = resolve(env.CLONE_DEST_DIR);

    for (const repoUrl of clonedUrls) {
        const repoName = resolveRepoFolderName(repoUrl);
        const repoDir = resolve(baseCloneDir, repoName);

        try {
            if (outputMode === 'markdown') {
                const { filePath } = await estimatorService.estimateAndSaveMarkdown(repoDir);
                console.log(`Arquivo .md gerado para ${repoName}: ${filePath}`);
            } else {
                const metrics = await estimatorService.estimateFromRepository(repoDir);
                console.log(`\nEstimativas para ${repoName}:`);
                console.dir(metrics, { depth: null });
            }
        } catch (error) {
            console.error(`Erro ao estimar ${repoName}:`, error);
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
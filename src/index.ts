import { selectRepositories } from '@/cli/prompt';
import { GitService } from '@/services/git.service';
import { GitHubService } from '@/services/github.service';
import { ExitPromptError } from '@inquirer/core';
import { confirm } from '@inquirer/prompts';

/**
 * Main CLI orchestration function that lists GitHub repositories, clones selected ones
 * shallowly, and asks whether to run hour estimation metrics next.
 */
async function main() {
    // Step 1: Instantiate GitHub and Git services.
    const githubService = new GitHubService();
    const gitService = new GitService();

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

    for (const repoUrl of selectedUrls) {
        console.log(`\nClonando: ${repoUrl}...`);

        try {
            await gitService.cloneShallow(repoUrl);
            console.log(`Concluído: ${repoUrl}`);
        } catch (error) {
            console.error(`Erro ao clonar ${repoUrl}:`, error);
        }
    }

    // Step 5: Ask the user whether to run estimates now after cloning finishes.
    const shouldEstimate = await confirm({
        message: 'Deseja realizar as estimativas agora que os repositórios foram clonados? (Y/N)',
        default: false,
    });

    // Step 6: If the user chooses N (false), say goodbye and exit cleanly without errors.
    if (!shouldEstimate) {
        console.log('\nTudo certo! Até a próxima e bom código!');
        process.exitCode = 0;
        return;
    }

    // Step 7: Placeholder for running hour estimation / LLM tool in the next step.
    console.log('\nPreparando estimativas dos repositórios clonados...');
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
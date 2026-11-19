import { ExitPromptError } from '@inquirer/core';
import { selectRepositories } from '@/cli/prompt';
import { GitService } from '@/services/git.service';
import { GitHubService } from '@/services/github.service';

async function main() {
    const githubService = new GitHubService();
    const gitService = new GitService();

    console.log('Buscando repositórios no GitHub...');
    const repositories = await githubService.listRepositories();

    if (repositories.length === 0) {
        console.log('Nenhum repositório encontrado.');
        return;
    }

    const selectedUrls = await selectRepositories(repositories);

    if (selectedUrls.length === 0) {
        console.log('Nenhum repositório selecionado.');
        return;
    }

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

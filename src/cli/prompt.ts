import type { Repository } from '@/types/repository';
import { selectRepositoriesPrompt } from '@/cli/select-repositories.prompt';

export async function selectRepositories(
    repositories: Repository[],
): Promise<string[]> {
    return selectRepositoriesPrompt({
        message:
            'Selecione os repositórios para clonar (Espaço para marcar, Enter para confirmar):',
        pageSize: 15,
        choices: repositories.map((repo) => ({
            name: `${repo.fullName}${repo.isPrivate ? ' (privado)' : ''}`,
            value: repo.sshUrl,
            fullName: repo.fullName,
        })),
    });
}

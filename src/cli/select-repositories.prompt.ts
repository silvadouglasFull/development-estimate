import {
    ExitPromptError,
    createPrompt,
    isDownKey,
    isEnterKey,
    isSpaceKey,
    isUpKey,
    makeTheme,
    useKeypress,
    useMemo,
    usePagination,
    usePrefix,
    useState,
    type KeypressEvent,
} from '@inquirer/core';
import { styleText } from 'node:util';

type RepoChoice = {
    value: string;
    name: string;
    fullName: string;
    checked: boolean;
};

type SelectRepositoriesConfig = {
    message: string;
    pageSize?: number;
    choices: ReadonlyArray<{
        value: string;
        name: string;
        fullName: string;
    }>;
};

const theme = makeTheme({
    icon: {
        checked: styleText('green', '◉'),
        unchecked: '○',
        cursor: '❯',
    },
    style: {
        disabled: (text: string) => styleText('dim', text),
        description: (text: string) => styleText('cyan', text),
        searchTerm: (text: string) => styleText('cyan', text),
        keysHelpTip: (keys: [string, string][]) =>
            keys
                .map(
                    ([key, action]) =>
                        `${styleText('bold', key)} ${styleText('dim', action)}`,
                )
                .join(styleText('dim', ' • ')),
    },
});

function matchesLike(fullName: string, query: string): boolean {
    if (!query) return true;
    return fullName.toLowerCase().includes(query.toLowerCase());
}

function isSearchHotkey(key: KeypressEvent): boolean {
    return Boolean(key.ctrl && key.shift && key.name === 'f');
}

function isEscapeKey(key: KeypressEvent): boolean {
    return key.name === 'escape';
}

function isQuitKey(key: KeypressEvent): boolean {
    return key.name === 'q' && !key.ctrl;
}

export const selectRepositoriesPrompt = createPrompt<
    string[],
    SelectRepositoriesConfig
>((config, done) => {
    const pageSize = config.pageSize ?? 15;
    const [status, setStatus] = useState<'idle' | 'done' | 'exiting'>('idle');
    const prefix = usePrefix({ status: status === 'exiting' ? 'idle' : status, theme });
    const [items, setItems] = useState<ReadonlyArray<RepoChoice>>(
        config.choices.map((choice) => ({ ...choice, checked: false })),
    );
    const [filter, setFilter] = useState('');
    const [searchMode, setSearchMode] = useState(false);
    const [active, setActive] = useState(0);

    const visibleItems = useMemo(
        () => items.filter((item) => matchesLike(item.fullName, filter)),
        [items, filter],
    );

    const bounds = useMemo(() => {
        if (visibleItems.length === 0) {
            return { first: -1, last: -1 };
        }
        return { first: 0, last: visibleItems.length - 1 };
    }, [visibleItems]);

    const safeActive =
        bounds.first === -1 ? 0 : Math.min(active, bounds.last);

    useKeypress((key, rl) => {
        if (status !== 'idle') return;

        if (searchMode) {
            if (isEscapeKey(key)) {
                rl.clearLine(0);
                setFilter('');
                setSearchMode(false);
                setActive(0);
                return;
            }

            if (isEnterKey(key) || isSearchHotkey(key)) {
                rl.clearLine(0);
                setSearchMode(false);
                setActive(0);
                return;
            }

            if (isUpKey(key) || isDownKey(key)) {
                rl.clearLine(0);
                rl.write(filter);
                return;
            }

            // rl.line já reflete backspace e caracteres imprimíveis.
            setFilter(rl.line);
            setActive(0);
            return;
        }

        if (isQuitKey(key)) {
            setStatus('exiting');
            return;
        }

        if (isSearchHotkey(key)) {
            rl.clearLine(0);
            rl.write(filter);
            setSearchMode(true);
            return;
        }

        if (isEscapeKey(key) && filter) {
            setFilter('');
            setActive(0);
            return;
        }

        if (isEnterKey(key)) {
            setStatus('done');
            done(items.filter((item) => item.checked).map((item) => item.value));
            return;
        }

        if (bounds.first === -1) return;

        if (isUpKey(key) || isDownKey(key)) {
            rl.clearLine(0);
            const offset = isUpKey(key) ? -1 : 1;
            const next =
                (safeActive + offset + visibleItems.length) % visibleItems.length;
            setActive(next);
            return;
        }

        if (isSpaceKey(key)) {
            rl.clearLine(0);
            const current = visibleItems[safeActive];
            if (!current) return;

            setItems(
                items.map((item) =>
                    item.value === current.value
                        ? { ...item, checked: !item.checked }
                        : item,
                ),
            );
        }
    });

    if (status === 'exiting') {
        throw new ExitPromptError('User quit with q');
    }

    const message = theme.style.message(config.message, status);

    if (status === 'done') {
        const selected = items.filter((item) => item.checked).map((item) => item.name);
        const answer = theme.style.answer(
            selected.length > 0 ? selected.join(', ') : 'nenhum',
        );
        return [prefix, message, answer].filter(Boolean).join(' ');
    }

    // usePagination não lida com lista vazia (modulo por zero) — usa placeholder.
    const emptyPlaceholder: RepoChoice = {
        value: '',
        name: '',
        fullName: '',
        checked: false,
    };
    const paginationItems =
        visibleItems.length > 0 ? visibleItems : [emptyPlaceholder];

    const page = usePagination({
        items: paginationItems,
        active: visibleItems.length > 0 ? safeActive : 0,
        renderItem({ item, isActive }) {
            if (visibleItems.length === 0) {
                return theme.style.error(
                    'Nenhum repositório corresponde ao filtro.',
                );
            }
            const cursor = isActive ? theme.icon.cursor : ' ';
            const checkbox = item.checked ? theme.icon.checked : theme.icon.unchecked;
            const color = isActive ? theme.style.highlight : (text: string) => text;
            return color(`${cursor}${checkbox} ${item.name}`);
        },
        pageSize,
        loop: visibleItems.length > 0,
    });

    const helpLine = theme.style.keysHelpTip([
        ['↑↓', 'navegar'],
        ['espaço', 'marcar'],
        ['ctrl+shift+f', 'buscar'],
        ['q', 'sair'],
        ['⏎', 'confirmar'],
    ]);

    const searchLine = searchMode
        ? `Buscar (LIKE %termo%): ${theme.style.searchTerm(filter || '')}`
        : filter
            ? theme.style.description(`Filtro ativo: %${filter}%  (Esc para limpar)`)
            : '';

    return [
        [prefix, message].filter(Boolean).join(' '),
        searchLine,
        page,
        ' ',
        helpLine,
    ]
        .filter(Boolean)
        .join('\n')
        .trimEnd();
});

### Panorama Geral do Resumo Técnico

* **O que o resumo reúne:** Uma visão clara e estruturada da arquitetura, tecnologias, fluxo de execução, decisões técnicas tomadas e o roteiro de gravação.
* **Como funciona a ferramenta:**
1. Busca repositórios no GitHub, permite escolher a branch por repositório e clona/atualiza localmente.
2. Lê o histórico do Git (`--no-merges`, janela padrão de `1 year ago`), agrupa commits por dia ativo e calcula horas otimistas, base e conservadoras com base nos pesos configurados (`3.5h` por dia ativo, `0.1h` por arquivo único, fatores `0.8` e `1.3`).
3. Gera `estimation.md` por repositório (e pode exibir no console).
4. Lê os `estimation.md` dos projetos analisados, divide textos/Markdown em chunks via splitters e gera **um único `analysis.md` consolidado** para o projeto descrito pelo usuário (ex.: estimativa de tempo e cobrança).


* **Passos e suposições:** Assume-se Node/TypeScript com execução via `tsx` / `node`, Jest em modo VM modules (`NODE_OPTIONS=--experimental-vm-modules jest`) e variáveis de ambiente carregadas via `.env`.

### Resumo Técnico da Ferramenta

#### 1. Por que a ferramenta foi criada

A ferramenta foi criada para tornar estimativas de **tempo, prazo e cobrança/esforço** mais realistas e baseadas em evidências. Em vez de estimar novos projetos no "achismo", ela usa o histórico real de commits e dias ativos do desenvolvedor (calibrado para um ritmo de trabalho próximo a ~4h/dia e commits granulares) e combina esses dados com um LLM para comparar projetos já feitos com a descrição de um novo projeto.

#### 2. Stack usada e bibliotecas

* **Linguagem e Runtime:** TypeScript e Node.js (`node:child_process`, `node:fs/promises`, `node:path`, `node:util`).
* **Execução, Build, Lint e Testes:** `tsx`, `tsup`, `tsc`, `jest` (com `NODE_OPTIONS=--experimental-vm-modules`), `biome` e `pnpm`.
* **Validação e CLI Interativo:** `zod` (validação de variáveis de ambiente em `src/env.ts`) e `@inquirer/prompts` + `@inquirer/core` (`select`, `confirm`, `input`, `ExitPromptError`).
* **LLM e Processamento de Texto:** `@langchain/openai` (`ChatOpenAI`), `@langchain/core` (`HumanMessage`, `SystemMessage`) e `@langchain/textsplitters` (`MarkdownTextSplitter`, `RecursiveCharacterTextSplitter`).
* **Serviços / Módulos do Projeto:** `GitHubService`, `GitService`, `GitWorkHourEstimatorService`, `LlmEstimatorAnalysisService`, `src/cli/prompt.ts`, `src/env.ts` e `src/index.ts`.

#### 3. O que a ferramenta faz (e o que ajustamos)

* **Listagem, seleção e clonagem (`src/index.ts`):** Lista repositórios via GitHub, permite selecionar os projetos, escolhe a branch por repositório e clona/atualiza na pasta configurada (`CLONE_DEST_DIR`).
* **Estimativa de horas via Git (`src/services/git-work-hour.service.ts` e `src/services/constants/git-work-hours-estimator-service.constants.ts`):**
* Usa janela padrão de `'1 year ago'` e flag `--no-merges` para focar em commits reais de implementação.
* Calcula métricas agrupando commits no mesmo dia como 1 dia ativo e contabilizando arquivos únicos tocados, gerando `optimisticHours`, `baseHours` e `conservativeHours` com `DEFAULT_HOUR_ESTIMATION_CONFIG` (`hoursPerActiveDay: 3.5`, `hoursPerUniqueFile: 0.1`, `optimisticFactor: 0.8`, `conservativeFactor: 1.3`) e comentários em inglês explicando como outros devs podem calibrar os valores.
* Limita a tabela de histórico do Markdown a 100 linhas mais recentes e salva `estimate/<REPO>/estimation.md`.


* **Tipagem compartilhada (`src/types/work-hour-estimator.types.ts`):** Adicionada a propriedade opcional `branch?: string` diretamente em `WorkLogFilters` para evitar erros de tipo (`TS2339`) em filtros e métricas aplicadas.
* **Análise consolidada com LLM (`src/services/llm-estimator-analysis.service.ts` e `src/index.ts`):**
* Valida/trimma `OPENAI_API_KEY`, trata erros de autenticação (`401` / chave expirada) com *fingerprint* seguro (sem expor a chave inteira) e usa `MarkdownTextSplitter` + `RecursiveCharacterTextSplitter` respeitando limites de caracteres.
* Refatorado para `generateConsolidatedAnalysis`: lê o `estimation.md` de cada projeto analisado (e docs `.md` dentro do orçamento), envia tudo junto com a descrição do novo projeto do usuário e salva **um único `analysis.md` consolidado** (em `estimate/analysis.md`).


* **Testes unitários (`src/services/__test__/git-work-hour.service.spec.ts` e `src/services/__test__/llm-estimator-analysis.service.spec.ts`):** Atualizados para os novos pesos/filtros do Git e para o fluxo consolidado de análise com LLM.
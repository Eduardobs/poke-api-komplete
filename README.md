# Poké API Komplete

API independente com REST v2 e GraphQL v1beta2 compatíveis com os contratos públicos da PokeAPI. Os dados são copiados dos CSVs versionados, sem consultar a API pública durante as requisições. Não há campos ou funcionalidades novos nesta versão.

O backend de produção é **Node.js + PostgreSQL**, com compilação das consultas GraphQL para SQL parametrizado. O contrato não foi redesenhado: o schema e a introspecção oficiais permanecem em `contracts/`. Django é usado apenas para gerar/importar o snapshot; Hasura fica como referência de testes e opção de retorno.

## Infraestrutura gratuita

| Componente | Hospedagem | Função |
| --- | --- | --- |
| API completa | Render Free | REST, GraphQL próprio e console |
| Banco próprio | Neon Free | Snapshot relacional persistente |
| Entrada opcional recomendada | Cloudflare Workers Free + Static Assets | REST na borda e cache de consultas GraphQL anônimas |

É possível começar apenas com **Render + Neon**; o domínio `onrender.com` atende todos os endpoints. Para reduzir latência de REST e consultas repetidas, use o Worker como domínio público. O Worker executa a lógica REST sobre arquivos locais e encaminha os misses GraphQL ao seu backend. GitHub Pages pode hospedar documentação, mas não executa o backend GraphQL nem reproduz sozinho a paginação e os erros REST.

O cache GraphQL do backend dura 60 segundos, com orçamento de 16 MiB de conteúdo. Documentos validados têm cache de 8 MiB/128 entradas, e arquivos REST, 16 MiB. Leituras simultâneas do mesmo arquivo compartilham a operação de disco em andamento; lotes GraphQL bem-sucedidos reutilizam o JSON serializado de cada resposta. O pool usa até quatro conexões, encerra conexões ociosas e não consulta o banco no health check. Na borda, respostas REST e respostas GraphQL bem-sucedidas são armazenadas por até 60 segundos; erros não entram no cache. Variáveis, documento, operação, domínio e backend participam da chave. Requisições com autorização/cookies não usam o cache da borda.

As cotas gratuitas continuam valendo: [Workers Free](https://developers.cloudflare.com/workers/platform/limits/) tem 100 mil requisições/dia e 10 ms de CPU por requisição; [Render Free](https://render.com/docs/free) suspende após 15 minutos de inatividade e exige um cold start ao voltar. A instância Free tem [512 MB e 0,1 CPU](https://render.com/docs/compute-plans). O [Neon Free passou a oferecer 1 GB por projeto](https://neon.com/blog/neon-free-plan-1-gb-per-project); confira também as cotas de computação/tráfego na conta. O snapshot importado ocupa aproximadamente 198 MiB, incluindo o índice composto de movimentos, com 1.235.381 linhas. Não há garantia de disponibilidade ou latência constante nos planos gratuitos. Não use o PostgreSQL Free do Render para persistência, pois expira em 30 dias.

## Preparar os dados

Requisitos: Node.js 22, Python 3.14 e [uv](https://docs.astral.sh/uv/getting-started/installation/). Docker Compose é opcional para o ambiente local.

```sh
cd vendor/pokeapi
uv sync --locked --no-dev --no-install-project
cd ../..
npm ci
npm run data:build
npm test
```

O build importa os CSVs para SQLite e gera `public/` e `src/generated/`, incluindo o catálogo relacional do backend. São centenas de MiB e a geração pode levar vários minutos. Os dados temporários, ambientes virtuais e segredos são ignorados no Git e no contexto Docker.

Após alterar os CSVs, remova `vendor/pokeapi/.snapshot-db-ready` e gere novamente. Para atualizar PostgreSQL, importe em **outro banco vazio**, valide e então troque a conexão: o importador não sobrescreve dados existentes.

As descrições resumidas dos 937 golpes em português brasileiro são mantidas pelo projeto em `data/translations/`. O build aplica as traduções ao SQLite mesmo quando o snapshot já está em cache. REST expõe os textos em `flavor_text_entries` e, para golpes com efeito cadastrado, em `effect_entries` (`effect` e `short_effect` contêm o mesmo resumo). GraphQL expõe os mesmos dados nas relações `moveflavortexts` e `moveeffecteffecttexts`, com `language_id: 13` (`pt-br`). Os resumos já existentes são preservados; as demais descrições de jogos são traduzidas a partir do texto em inglês de cada `version_group`, incluindo as versões históricas. Os textos dos demais idiomas são preservados. Depois de adicionar ou editar traduções, execute `npm run data:build` e atualize o PostgreSQL pelo processo acima.

Os demais recursos também recebem descrições em `pt-br`: habilidades (efeitos completos, resumos e alterações históricas), espécies (textos da Pokédex, categoria e formas), itens e seus efeitos, características, crescimento, métodos de aprendizado, alvos e categorias de golpes, concursos e variáveis de evolução. As traduções automáticas são versionadas em [data/translations/](data/translations/README.md), com validação de cobertura e limites do banco. Para textos que variam por jogo, são incluídas entradas para todas as versões disponíveis em inglês, preservando `version` ou `version_group`. REST usa `language.name: "pt-br"`; GraphQL usa `language_id: 13`. O build e a API funcionam sem serviço externo de tradução. O registro `data/translations/locales.json` centraliza os idiomas e seus catálogos; o pipeline compartilhado aplica as traduções em uma transação, com gravações em lote e sem regravar textos inalterados. Consulte o guia de traduções para adicionar idiomas e selecionar textos nas duas APIs.

## Atualizar a base original

A base acompanha a [master do PokeAPI](https://github.com/PokeAPI/pokeapi). Peça ao Codex **“Cheque atualizações do PokeAPI desde a última sincronização”** ou **“Atualize a base do PokeAPI”**. A skill versionada está em [skills/pokeapi-sync/SKILL.md](skills/pokeapi-sync/SKILL.md), com descoberta neste repositório orientada por `AGENTS.md`.

```sh
npm run upstream:check  # consulta e lista diferenças, sem aplicar fontes
npm run upstream:sync   # aplica diferenças após verificar conflitos
```

`upstream.lock.json` guarda o commit sincronizado, `last_synced_at` e `last_checked_at` em UTC. A data inicial foi recuperada do commit que introduziu o lock (`last_synced_at_source` registra essa origem); as próximas sincronizações registram o horário efetivo. A comparação usa o SHA para não perder commits por diferenças de datas. Uma consulta sem novidades preserva a data da sincronização. `last_checked_commit` pode ser mais recente que `commit` quando existem atualizações pendentes.

O sincronizador preserva adaptações que não conflitam, exige vendor/lock sem alterações pendentes e interrompe em conflitos, histórico divergente ou alterações de submódulos. Cries e manifesto de sprites mantêm seus controles próprios. Ao aplicar mudanças, remove o SQLite local e seu marcador de cache para o próximo build reconstruir os dados. Traduções próprias ficam em `data/translations/`.

Depois de aplicar, siga a skill para revisar dependências, regenerar dados e validar traduções, API e compatibilidade. A sincronização de fontes não significa validação ou publicação: `last_validated_commit`/`last_validated_at` só devem ser registrados após os checks necessários passarem. Banco remoto e deploy seguem o procedimento de publicação, separadamente.

## Executar localmente

```sh
cp .env.example .env
# Edite POSTGRES_PASSWORD; use uma senha própria segura para URLs.
docker compose --env-file .env up -d postgres
export DATABASE_URL='postgresql://pokeapi:SUA_SENHA@localhost:5432/pokeapi'
npm run graphql:seed
npm start
```

A API completa estará em `http://localhost:8080`. Alternativamente, `docker compose --env-file .env up -d --build backend` constrói e executa a imagem de produção; não execute ao mesmo tempo que `npm start` na mesma porta. A imagem gera o snapshot durante o build e executa somente Node em produção, sem Python ou Hasura.

Para testar a entrada Cloudflare:

```sh
cp .dev.vars.example .dev.vars
# GRAPHQL_BACKEND_URL=http://localhost:8080/v1beta2
npm run dev
```

O Worker estará em `http://localhost:8787`. O Cache API da borda depende do ambiente Cloudflare; não conte com persistência de cache no desenvolvimento local.

## Publicar: passo a passo

1. Envie o repositório, incluindo `vendor/`, `contracts/` e os arquivos de implantação, para sua conta GitHub. Não envie `.env`, `.dev.vars`, o SQLite ou ambientes virtuais. Aguarde o workflow **Verify PokeAPI compatibility** ficar verde antes da primeira implantação: ele inclui o build Docker que não pôde ser executado neste ambiente local.
2. Crie um projeto **Neon Free**, em uma região próxima à que usará no Render. Crie um banco vazio e copie sua **URL de conexão direta**, com SSL. Configure no terminal:

   ```sh
   export DATABASE_URL='postgresql://USUARIO:SENHA@SEU_HOST/SEU_BANCO?sslmode=require'
   npm run graphql:seed
   ```

   Execute após preparar os dados acima. Espere a importação terminar; ela cria as tabelas e copia o snapshot próprio. A senha fica apenas no seu ambiente local e no provedor.
3. No **Render**, escolha **New → Blueprint**, conecte o repositório e selecione `render.yaml`. Ele usa o plano `free` e `deploy/backend/Dockerfile`. Informe `DATABASE_URL` com a conexão direta do Neon. Não é necessário configurar Hasura ou chave administrativa. Selecione uma região próxima ao Neon e aguarde o build/health check. O Render fornece `https://SEU-SERVICO.onrender.com`. As próximas implantações automáticas usam [`autoDeployTrigger: checksPass`](https://render.com/docs/blueprint-spec), aguardando a aprovação dos checks da CI.
4. Verifique REST e GraphQL diretamente no Render:

   ```sh
   curl --fail https://SEU-SERVICO.onrender.com/api/v2/pokemon/25/
   curl --fail https://SEU-SERVICO.onrender.com/v1beta2 \
     -H 'Content-Type: application/json' \
     --data '{"query":"{pokemon(where:{id:{_eq:25}}){id name}}"}'
   ```

   A segunda resposta deve conter `id: 25` e `name: "pikachu"`. O primeiro acesso depois da suspensão pode demorar. O console fica em `/v1beta2/console/`.
5. Para publicar a entrada rápida no **Cloudflare Workers Free**, execute na raiz, após gerar o snapshot:

   ```sh
   npx wrangler login
   npx wrangler secret put GRAPHQL_BACKEND_URL
   # Informe https://SEU-SERVICO.onrender.com/v1beta2
   npm run build
   npm run deploy
   ```

   A URL pública será `https://poke-api-komplete.SUA-CONTA.workers.dev`. O Worker precisa apenas da URL do seu backend; não recebe `DATABASE_URL` nem senha de banco. Se faltar essa configuração, REST funciona e GraphQL retorna 503.
6. Repita as verificações do passo 4 no domínio `workers.dev`. Use esse domínio como base da integração. Nas atualizações de snapshot, atualize Render e os assets do Worker juntos e altere a variável Cloudflare `CACHE_VERSION` para invalidar imediatamente o cache da borda; caso contrário, ele expira em até 60 segundos.

As contas e a publicação remota precisam ser feitas pelo proprietário. O projeto não provisiona contas nem habilita planos pagos. Na ausência do Worker, o domínio Render continua oferecendo a API completa. Se uma requisição REST muito grande exceder o limite de CPU do Worker Free, o domínio Render é a alternativa sem esse limite específico de 10 ms.

## Publicação automática do Worker

O workflow `.github/workflows/check.yml` pode publicar o Worker após todos os testes, benchmark e build/teste Docker passarem. Usa o mesmo checkout e os mesmos assets validados, sem gerar novamente o snapshot. A publicação ocorre apenas em pushes para a branch padrão do repositório (atualmente `master` neste checkout); pull requests e outras branches não publicam.

Configuração única:

1. No Cloudflare, crie um API Token com o modelo **Edit Cloudflare Workers**, limitado à conta em que publicará. Copie também o **Account ID** dessa conta. Consulte a [documentação oficial da integração com GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
2. No GitHub, abra **Settings → Secrets and variables → Actions → Secrets** e cadastre três *repository secrets*:

   | Secret | Valor |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | Token criado no Cloudflare |
   | `CLOUDFLARE_ACCOUNT_ID` | ID da conta Cloudflare |
   | `GRAPHQL_BACKEND_URL` | `https://SEU-SERVICO.onrender.com/v1beta2` |

3. Na aba **Variables** da mesma página, crie a *repository variable* `ENABLE_WORKER_DEPLOY` com o valor literal `true`.
4. Envie um commit com o workflow para a branch padrão. No GitHub Actions, acompanhe **Verify PokeAPI compatibility → Deploy tested Worker and snapshot to Cloudflare**. Sem a variável de habilitação, o passo aparece como ignorado e os testes continuam funcionando.

O Wrangler autentica por token, sem `wrangler login` na CI. O workflow cadastra `GRAPHQL_BACKEND_URL` como secret do Worker na própria publicação e usa o SHA do commit em `CACHE_VERSION`, invalidando o cache da borda a cada deploy. As execuções da mesma branch são serializadas para evitar publicações concorrentes. Se habilitar a publicação sem os secrets, o passo falha com uma mensagem indicando a configuração ausente.

Para desativar a automação, remova `ENABLE_WORKER_DEPLOY` ou altere seu valor para `false`. O comando manual `npm run deploy` continua disponível. A automação publica o Worker e seus assets; a importação de um novo banco e a coordenação das atualizações do dataset entre Neon/Render/Cloudflare continuam seguindo o procedimento anterior. O Render, configurado com `checksPass`, aguarda a conclusão desse workflow antes de iniciar seu deploy automático.

## Contratos disponíveis

REST: `/api/v2/`, as 50 coleções oficiais, `/api/v2/meta/` e `/api/v2/pokemon/{id}/encounters`. Há suporte a IDs, nomes, HEAD, CORS e redirecionamento `/api/v1/`. Paginação e erros `{status,message}` reproduzem a publicação oficial, inclusive `parseInt`, última página e `q` ignorado. As referências REST usam o domínio da implantação. Metadados têm `deploy_date`, `hash` e `tag`; `/snapshot.json` informa a origem do dataset.

GraphQL: **POST `/v1beta2`**, com `/graphql` como alias. O contrato inclui os 327 campos raiz oficiais, relações, filtros, ordenação, agregações, `distinct_on`, JSON, variáveis, aliases, fragments, diretivas, introspecção e operações em lote. Mutations não são públicas; subscriptions por HTTP são rejeitadas como na referência. Não há suporte novo a WebSocket. O console GraphiQL usa bibliotecas de CDN e as URLs de mídia continuam apontando aos repositórios oficiais no GitHub.

```sh
curl http://localhost:8080/v1beta2 \
  -H 'Content-Type: application/json' \
  --data '{"query":"query($name:String!){pokemon(where:{name:{_eq:$name}}){id name pokemontypes{type{name}}}}","variables":{"name":"pikachu"}}'
```

## Compatibilidade e desempenho

A análise dos gargalos e as melhorias de cache estão em [docs/PERFORMANCE.md](docs/PERFORMANCE.md). A [medição SQL com PostgreSQL real](docs/PERFORMANCE_SQL.md) detalha a otimização de agregações, o índice composto e sua aplicação em bancos existentes. `npm run benchmark:sql` registra planos, índices, memória e concorrência, com critérios automáticos contra escrita temporária nas agregações grandes. `npm run benchmark:local` mede a reutilização REST e a deduplicação GraphQL sem depender de PostgreSQL; grava um relatório separado em `contracts/local.performance.json`. O REST também reutiliza objetos JSON por até 60 segundos, com orçamento estimado de 16 MiB/128 entradas e isolamento por domínio, bindings e versão. Consultas GraphQL simultâneas idênticas compartilham a execução enquanto o cache de respostas está habilitado.

`npm run test:backend` verifica lotes GraphQL, resolução de campos e leituras concorrentes de arquivos sem exigir PostgreSQL ou Hasura (abre uma porta HTTP local).

Os contratos originais estão registrados em `contracts/rest.contract.json`, `contracts/graphql.schema.graphql` e `contracts/graphql.introspection.json`. Não regenere esses arquivos a partir do backend candidato para fazer testes passarem.

Para executar a referência Hasura com o mesmo PostgreSQL local:

```sh
docker compose --env-file .env --profile reference up -d hasura
export HASURA_GRAPHQL_URL='http://localhost:18080/v1/graphql'
export REFERENCE_GRAPHQL_URL="$HASURA_GRAPHQL_URL"
npm run test:integration
npm run test:compatibility
npm run test:http
npm run benchmark
npm run audit:rest:full
```

`DATABASE_URL` deve apontar para o banco próprio já importado. A suíte `test:compatibility` compara o backend SQL próprio com o Hasura independente, incluindo campos raiz, todas as relações, colunas, agregações relacionadas, exemplos e combinações de consultas/erros. Usa Linux + `prlimit` (`util-linux`), limita o processo a **19 GB de espaço de endereçamento** e o heap a 4 GB. Se não puder aplicar o limite, não inicia o teste. Execute pelo lançador, não pelo arquivo interno `.suite.js`.

O benchmark compara HTTP na mesma máquina e banco, com 30 amostras por consulta, cinco aquecimentos, backend com/sem cache e referência Hasura. Registra mediana, p95 e RSS amostrado em `contracts/backend.performance.json`. O gate exige p95 sem cache até `max(100 ms, 5× referência)`, mediana com cache até a sem cache + 1 ms e RSS amostrado abaixo de 384 MiB. Esses números não estimam a latência dos provedores gratuitos nem os cold starts.

A CI gera os dados, audita REST, sobe PostgreSQL/Hasura, compara as implementações, mede desempenho e então constrói/testa a imagem de produção com limite de 512 MiB. A implementação própria só foi promovida a padrão após passar nas verificações locais; o Hasura permanece no perfil `reference` para checagens e retorno. Para retornar ao Hasura na borda, aponte `GRAPHQL_BACKEND_URL` à sua instância `/v1/graphql`.

Leia [COMPATIBILITY.md](COMPATIBILITY.md) para as revisões, a evidência e as limitações da comparação. Os snapshots podem diferir da revisão de dados atualmente publicada na API oficial. Nenhuma suíte finita garante todas as combinações possíveis de consultas; as verificações registram o escopo efetivamente executado.

## Licenças

Código próprio: MIT. PokeAPI: BSD-3-Clause em `vendor/pokeapi/LICENSE.md`. Origem: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Pokémon e seus nomes são marcas da Nintendo; este projeto não é oficial.

### Tempo da pipeline

A CI guarda `public/`, `src/generated/` e o SQLite usado como referência em um cache por conteúdo das fontes, scripts, traduções, schema e manifesto de upstream. A chave é calculada antes da instalação Python; somente uma correspondência exata permite pular `data:build`. Alterações nesses insumos geram um snapshot novo. A auditoria REST completa, a carga PostgreSQL e os testes continuam executando mesmo com cache.

Após as validações, a imagem do backend usa o target `tested-snapshot` de `deploy/backend/Dockerfile`, com os mesmos arquivos já testados, sem reconstruir os dados. Esse target exige BuildKit e um snapshot completo no contexto; `Dockerfile.dockerignore` permite incluir os arquivos gerados. O build padrão usado pelo Render continua gerando o próprio snapshot.

No registro de referência de 38 minutos, `data:build` consumiu 11min38s, a auditoria REST 9min35s e o build Docker 13min14s. As otimizações removem a geração duplicada no Docker e, com cache válido, a geração inicial. O tempo restante inclui auditoria, PostgreSQL, transferência do cache e montagem da imagem; o ganho efetivo deve ser medido no GitHub Actions.

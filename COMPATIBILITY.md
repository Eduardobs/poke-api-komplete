# Compatibilidade com a PokeAPI

A verificação foi realizada em **9 de novembro de 2026**. A implementação inicial não era totalmente compatível: o GraphQL tinha schema próprio, a raiz REST omitia `meta`, os metadados tinham outro formato e a paginação tinha regras e limites diferentes. Esses comportamentos foram substituídos.

O objetivo é preservar o contrato público da API: caminhos, argumentos, estrutura dos corpos JSON, tipos GraphQL, relações, filtros, agregações e erros. Não se trata de reproduzir o site de documentação, o firewall, os endereços de domínio nem a capacidade operacional da hospedagem oficial.

## Referências verificáveis

| Referência | Revisão/arquivo |
| --- | --- |
| Código e CSVs copiados | `PokeAPI/pokeapi@5cbeb3f3eb55a9b86da52c4869336f9d61fdd6d7` |
| Publicação REST oficial | `PokeAPI/deploy@b58f61a80bd1be91e758cdab1d182ca913b9d693`, `functions_v1/src/index.js` |
| Inventário e paginação pública | `contracts/rest.contract.json` |
| Metadados GraphQL públicos | `vendor/pokeapi/graphql/v1beta2/metadata` |
| Motor de referência GraphQL | `hasura/graphql-engine:v2.50.2` |
| Introspecção anônima original | `contracts/graphql.introspection.json` |
| Backend de produção | Node.js 22, `src/backend/` |
| Medições comparativas | `contracts/backend.performance.json` |
| Auditoria GraphQL do backend próprio | `contracts/backend.compatibility.json` |
| Contrato GraphQL anônimo | `contracts/graphql.schema.graphql` |
| Auditoria REST completa | `contracts/rest.audit.json` |
| Revisão dos serializadores publicados | `contracts/deployed-source-review.json` |

O [índice público](https://pokeapi.co/api/v2/) apresenta **51 entradas**: 50 coleções e `meta`. A camada pública é documentada no [repositório oficial de publicação](https://github.com/PokeAPI/deploy). A [documentação GraphQL](https://pokeapi.co/docs/graphql) aponta para `https://graphql.pokeapi.co/v1beta2`, apenas POST; a versão v1beta anterior foi removida em novembro de 2026.

## Cobertura REST

- Raiz `/api/v2/`: todas as 51 entradas oficiais, incluindo `meta`.
- Todas as 50 coleções e todos os **14.134 detalhes** do snapshot.
- `/api/v2/pokemon/{id}/encounters`: todos os **1.351 Pokémon** do snapshot.
- `/api/v2/meta/`: `deploy_date`, `hash`, `tag`; a origem do dataset fica separadamente em `/snapshot.json`.
- Paginação pública: 60 casos executados nos helpers originais do Firebase, incluindo final de lista, offset excedente, valores padrão, negativos, inválidos e limites grandes.
- Nomes e maiúsculas/minúsculas, IDs negativos existentes, ausência de um teto próprio de paginação e `q` ignorado.
- Erros `{status, message}`, CORS, HEAD e redirecionamento legado `/api/v1/`.

A auditoria completa fez **15.537 comparações exatas de corpos JSON**: 14.134 detalhes, 1.351 encontros, 50 listagens completas, raiz e metadados. A referência foi o Django oficial sem modificações, executado sobre o mesmo snapshot local e domínio de teste. Não é uma comparação de duas cópias da implementação do Worker. O teste de paginação usa resultados capturados da implementação pública oficial, que é diferente do Django.

## Cobertura GraphQL

O backend de produção é próprio: Node.js compila as operações para SQL parametrizado em PostgreSQL. O schema e a introspecção de referência são carregados sem acrescentar campos. A execução não depende de Hasura ou da API pública. O Worker encaminha GraphQL ao backend próprio; `HASURA_GRAPHQL_URL` continua aceito como configuração legada para retorno à referência.

Foram executadas **1.506 comparações diferenciais de status e corpos JSON** entre o backend próprio e o Hasura oficial 2.50.2, com o mesmo snapshot PostgreSQL:

- Introspecção completa, incluindo descrições, tipos e ordem dos campos de introspecção legados.
- Os **327 campos raiz** oficiais.
- As **601 relações**, escolhendo registros com relação existente quando disponíveis, e as **299 agregações relacionadas** expostas.
- Todas as colunas públicas das **163 tabelas**.
- Execução dos exemplos `.gql` oficiais, inclusive operações nomeadas e variáveis.
- Combinações de filtros escalares/relacionais, predicados agregados, ordenação simples/relacional/agregada, `distinct_on`, paginação, JSON e caminhos JSON.
- Agregações numéricas, contagem distinta/multicoluna, aliases, fragments, diretivas, valores padrão e várias raízes em uma única ida ao PostgreSQL.
- Erros de validação, coerção de valores, variáveis, seleção, SQL, regex inválida, offsets negativos e permissões sem mutations/subscriptions HTTP.
- Envelopes HTTP, lotes de operações e erros de parsing/coerção de inteiros PostgreSQL.
- Cache de respostas bem-sucedidas; erros não são armazenados.

Os testes HTTP adicionais exercitam o servidor independente com REST, referências no próprio domínio, GraphQL, CORS, HEAD, console, erros e cache, incluindo 14 corpos JSON malformados comparados com a referência. O fluxo completo também passou no runtime local do Cloudflare conectado ao backend próprio, com MISS/HIT reais do cache da borda. Os testes da borda verificam isolamento de chaves, bypass de autorização e ausência de cache de erros.

O lançador `tests/backend.compatibility.test.js`, executado por `npm run test:compatibility`, exige Linux e `prlimit` (`util-linux`): limita o espaço de endereçamento a **19.000.000.000 bytes** e o heap do Node a **4.096 MiB**. Sem o limite, não inicia. As falhas mostram apenas a primeira divergência para evitar diagnósticos gigantes da introspecção. O arquivo `.suite.js` é interno e deve ser executado pelo lançador.

### Desempenho e promoção

As verificações locais passaram no Node 22 e no Node 26. O relatório `contracts/backend.performance.json` registra 30 amostras HTTP por operação e cinco aquecimentos, com consulta simples, listagem, relações, agregação e JSON. Compara Hasura e backend próprio com/sem cache usando o mesmo banco local. Inclui mediana, p95 e RSS amostrado do processo que executa duas instâncias e o cliente HTTP.

O gate de promoção exige p95 sem cache abaixo de `max(100 ms, 5× p95 da referência)`, mediana com cache até a mediana sem cache + 1 ms e RSS amostrado abaixo de 384 MiB. Ele foi aprovado antes de mudar `render.yaml` para o backend próprio. Essas tolerâncias verificam regressões graves; não significam que toda consulta sem cache será mais rápida que Hasura.

A CI repete os testes, a auditoria REST e o benchmark e só então constrói a imagem de produção e a testa com limite de 512 MiB. O Docker local não tinha daemon disponível; por isso a construção da imagem é uma verificação configurada na CI, ainda não executada nesta sessão. Nenhum serviço remoto foi publicado. O Hasura permanece no perfil Compose `reference`, com os metadados inalterados, para comparação e retorno.

Não há ordenação garantida em SQL sem `order_by`. Os cenários que comparam listas em operações com planos diferentes definem ordenação explícita. Nenhuma suíte finita certifica todas as combinações possíveis de consultas. Os resultados acima cobrem o schema e os cenários efetivamente executados, não uma prova universal de equivalência nem um SLA do plano gratuito.

## Limites desta conclusão

As consultas diretas automatizadas a `pokeapi.co` foram bloqueadas pelo Cloudflare com **HTTP 403 / código 1010** neste ambiente. Portanto **não há certificação de igualdade, ao vivo, de todas as respostas do serviço público**. A evidência obtida é a igualdade com as implementações oficiais e os contratos registrados nas revisões acima.

O `/meta/` público acessível pela ferramenta de consulta informou o hash `e2710d30d14b3f4dc6a02a4a71e8619cd835b7ff`. A cópia vendorizada está 15 commits à frente. A comparação oficial entre revisões não contém alterações nos CSVs, modelos, migrations ou metadados GraphQL. Os serializadores da revisão publicada também foram carregados contra o mesmo banco e comparados nos primeiros e últimos detalhes de todas as coleções: **100 respostas sem diferenças**. Essa checagem adicional está registrada em `contracts/deployed-source-review.json`; ela não afirma igualdade das mídias ou do manifesto de sprites entre implantações.

Snapshots podem estar em revisões diferentes do serviço público. O domínio das referências REST e os valores de metadados de implantação são próprios. As URLs de mídias continuam nos repositórios oficiais do GitHub. Cache, bloqueios de firewall, cold starts, limites de carga e disponibilidade dependem do provedor. A hospedagem gratuita tem cotas próprias.

O domínio Render oferece REST e GraphQL diretamente, com `DATABASE_URL` para o PostgreSQL próprio. Para GraphQL funcionar também no Worker, configure `GRAPHQL_BACKEND_URL` com a URL `/v1beta2` desse backend. A aplicação não consulta o serviço público como fallback; sem backend configurado no Worker, GraphQL retorna 503.

## Reproduzir e manter

```sh
npm test
npm run audit:rest:full
# Configure DATABASE_URL e REFERENCE_GRAPHQL_URL; Hasura apenas como referência:
npm run test:compatibility
npm run test:http
npm run benchmark
# Para verificar também o proxy legado, configure HASURA_GRAPHQL_URL:
npm run test:integration
```

`node scripts/capture_deploy_contract.mjs /caminho/do/checkout/PokeAPI/deploy` recaptura o inventário e as referências de paginação a partir de um checkout oficial revisado. `npm run graphql:schema` captura o schema anônimo de sua instância. Atualize as referências somente após revisar mudanças oficiais e os respectivos hashes.

Novas informações do projeto devem usar uma versão ou namespace separado, mantendo os contratos oficiais v2 e v1beta2. Remover campos, mudar tipos, alterar argumentos ou modificar o significado de operações existentes deve causar falha na verificação de compatibilidade.

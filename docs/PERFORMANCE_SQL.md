# Medição de SQL, índices e concorrência

A segunda rodada usa o snapshot PostgreSQL local real e o Hasura independente, ambos disponíveis no ambiente de testes. Foram medidas oito classes de consulta com cache de respostas desativado, cinco aquecimentos e 30 amostras por operação. `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` registra os planos completos. Os relatórios comparam hashes das respostas para impedir mudanças silenciosas nos resultados.

## Melhorias implementadas

O compilador materializava uma CTE com todas as colunas mesmo para uma contagem simples. Na tabela de movimentos, isso escrevia 2.668 blocos temporários, aproximadamente 20,8 MiB por execução medida. Agora uma CTE com apenas um consumidor permite inlining pelo PostgreSQL. Quando `aggregate`, `nodes` ou aliases precisam compartilhar o resultado, a materialização permanece e inclui somente as colunas consumidas.

A projeção inclui colunas de contagem, funções numéricas, campos de `nodes` e chaves locais usadas pelas relações. Fragmentos, aliases e diretivas participam dessa coleta. Uma seleção sem colunas usa uma constante por linha, preservando a cardinalidade. O caminho com `distinct_on` mantém a projeção anterior: a primeira tentativa de estreitá-la acrescentou custo de CPU no incremental sort medido.

Um índice B-tree adicional em `pokemon_v2_pokemonmove (pokemon_id, id)` atende o filtro por Pokémon seguido da ordenação por ID. Na medição, eliminou o sort de consultas relacionadas com limite e melhorou a paginação com `distinct_on`. O custo observado é de 14.368.768 bytes, aproximadamente 13,7 MiB; esse espaço é adicional aos índices existentes. Não foram criados índices indiscriminadamente nas outras tabelas.

O importador agora conclui as verificações de chaves estrangeiras diferidas, cria o índice e executa `ANALYZE` nas tabelas importadas antes do commit. Assim, novos snapshots têm o índice e estatísticas de planejamento desde a primeira consulta. O importador continua recusando bancos que já contêm dados.

## Resultados

Medianas locais, em milissegundos, medidas no Node 22.23.4 e PostgreSQL 18.6:

| Consulta | Antes | Compilador otimizado | Compilador e índice |
| --- | ---: | ---: | ---: |
| Contagem de movimentos | 51,679 | 8,721 | 8,847 |
| Contagem, média e máximo de movimentos | 69,008 | 14,360 | 14,438 |
| Agregação em tabela com JSON | 0,616 | 0,351 | 0,334 |
| Agregação com 10 mil nodes | 29,719 | 28,172 | 29,171 |
| `distinct_on`, ordenação e paginação | 15,441 | 15,502 | 10,850 |
| Agregações relacionadas a 20 Pokémon | 2,558 | 2,024 | 2,099 |
| Relações com ordenação e limite | 4,480 | 4,260 | 1,720 |
| Lookup simples | 0,374 | 0,395 | 0,382 |

A contagem ficou aproximadamente 83% mais rápida; a agregação numérica, 79%; a consulta com relações ordenadas, 62%. Os blocos temporários escritos nas duas agregações grandes caíram para zero. O lookup simples ficou equivalente dentro da variação observada. Esses percentuais não são estimativas de latência dos provedores gratuitos.

A medição com 32 consultas de variáveis distintas, usando quatro conexões e sem cache de respostas, observou até 27 consultas esperando conexão e p95 de aproximadamente 10,00 ms. O RSS amostrado do processo Node durante o benchmark SQL atingiu 134,2 MiB. A medição inclui engine e cliente PostgreSQL; não inclui a memória do servidor PostgreSQL. O benchmark HTTP, com dois apps e cliente no mesmo processo, registrou 148,6 MiB e passou nos limites existentes. Não há evidência suficiente nesse teste curto para aumentar o pool de produção; a latência de rede de produção pode alterar a espera.

Os relatórios registram execuções em sequência no mesmo ambiente, não um experimento aleatório entre binários; frequências de CPU, aquecimento e concorrência do sistema podem variar. Ganhos grandes nas agregações são acompanhados pela eliminação do spill nos planos. Diferenças pequenas não devem orientar ajustes de infraestrutura.

## Reproduzir e manter os critérios

Com o snapshot próprio já importado:

```sh
export DATABASE_URL='postgresql://USUARIO:SENHA@localhost:5432/pokeapi'
npm run benchmark:sql
```

Para comparar os conteúdos com um relatório anterior do mesmo snapshot:

```sh
npm run benchmark:sql -- /tmp/sql-depois.json contracts/sql.performance.before.json
```

O primeiro argumento define o arquivo de saída; o segundo, opcional, fornece os hashes esperados. O benchmark falha se as respostas diferirem, quando uma das duas agregações grandes escrever blocos temporários ou se o RSS do processo atingir 384 MiB. Não impõe os tempos absolutos desta máquina a outros ambientes. O workflow de CI executa esse benchmark após o benchmark HTTP e inclui seu relatório no artifact de desempenho.

Relatórios versionados:

- `contracts/sql.performance.before.json`: compilador e índices anteriores.
- `contracts/sql.performance.compiler.json`: compilador otimizado, antes do índice adicional.
- `contracts/sql.performance.json`: versão final, com queries, índices, espaço utilizado, planos, amostras de RSS e concorrência.
- `contracts/backend.performance.json`: benchmark HTTP atualizado contra Hasura, com e sem cache.
- `contracts/backend.compatibility.json`: comparação atualizada de 1.518 requisições com o contrato anônimo Hasura.

## Aplicar a um banco já importado

O compilador muda com o deploy do backend. O índice e as estatísticas de um banco já existente precisam ser atualizados separadamente por quem administra esse banco. Não execute novamente o seed em um banco com dados.

Execute o SQL abaixo fora de uma transação explícita; `CONCURRENTLY` permite manter o atendimento durante a criação do índice:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS pokeapi_pokemonmove_pokemon_id_id_idx
ON pokemon_v2_pokemonmove (pokemon_id, id);
ANALYZE pokemon_v2_pokemonmove;
```

O teste local usou um banco dedicado e criação normal do índice; a variante concorrente acima é a orientação operacional para um banco em atendimento. Nenhuma alteração foi enviada a bancos ou serviços remotos nesta tarefa.

## Validação e limites

A importação completa em um banco temporário separado também passou: 1.235.381 linhas carregadas, índice de 14.368.768 bytes e estatísticas explícitas nas 165 tabelas importadas.

Passaram os 18 testes de `npm test`, quatro testes HTTP, 14 grupos da suíte comparativa com 1.518 requisições, benchmark HTTP, benchmark SQL e build do Worker. Os casos adicionais comparam contagens compostas, agregações e nodes simultâneos, relações a partir de nodes, `distinct_on`, paginação, aliases, fragments, diretivas, JSON e conjuntos vazios contra o Hasura.

A validação não inclui latência de Neon/Render, TLS/CDN, cold starts, teste prolongado de carga nem publicação remota. O índice adiciona custo de escrita e espaço; o snapshot de produção é usado para leitura, então a criação ficou concentrada na importação. Ganhos de produção devem ser confirmados com métricas do tráfego real antes de ajustar memória ou conexões.

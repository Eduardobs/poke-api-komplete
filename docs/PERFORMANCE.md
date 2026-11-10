# Análise de desempenho

A continuação com PostgreSQL real, planos SQL, índice composto e resultados atualizados está em [PERFORMANCE_SQL.md](PERFORMANCE_SQL.md).

A análise acompanhou os caminhos REST (`worker.js`, assets e paginação), GraphQL (validação, compilação SQL, execução e serialização), caches, pool PostgreSQL e scripts de medição. As mudanças concentram-se em trabalho repetido identificado diretamente no código e validado por testes e medição local.

## Diagnóstico e mudanças

| Caminho | Custo encontrado | Implementação |
| --- | --- | --- |
| REST sem hit de borda | `store()` era criado por requisição: o cache de arquivos do Node poupava disco, mas `text()`, substituição do domínio e `JSON.parse()` se repetiam para índice, shard e metadados. | Cache LRU de objetos já interpretados, compartilhado por bindings, com TTL de 60 segundos. |
| REST concorrente | A deduplicação dentro de `store()` não compartilhava leitura/interpretação entre requisições. | Promessas em andamento compartilhadas entre stores; erros removem a promessa para permitir nova tentativa. |
| GraphQL concorrente | O cache de respostas só era preenchido após a execução. Uma rajada da mesma consulta podia repetir validação de entradas, compilação, SQL e serialização. | Requisições com a mesma chave compartilham a execução em andamento. O contador `engine.metrics.coalescedRequests` permite observar esse reaproveitamento. |
| Regressões | Os testes do backend existiam em comando separado, mas não estavam no `npm test` usado pela CI. | Testes do backend e do novo cache REST incluídos em `npm test`. |

O cache REST tem orçamento contábil de 16 MiB e até 128 entradas. A contabilização usa seis bytes por caractere do JSON e dois por caractere da chave, uma estimativa conservadora, sem representar limite exato do heap. Entradas grandes demais continuam funcionando, mas não ficam no cache compartilhado. Cada processo/isolate possui seu próprio orçamento, somado aos caches de assets e GraphQL existentes. Não há timers de manutenção; expiração e remoção acontecem no acesso e na inserção.

Bindings são isolados por `WeakMap`, permitindo coleta quando deixam de ser usados. Domínio, `CACHE_VERSION` e caminho participam da chave REST: URLs reescritas não são reutilizadas em outro domínio. A atualização de versão invalida logicamente os dados anteriores; arquivos de um snapshot em execução devem ser tratados como imutáveis. Uma alteração de arquivo sem atualização de versão pode levar até 60 segundos para aparecer.

Até 128 chaves de operações em andamento são retidas por mecanismo. Ao alcançar esse limite, requisições adicionais continuam pela execução normal, sem ampliar o mapa compartilhado. Esse limite não é um limitador de concorrência global. O pool continua sendo o limite de conexões PostgreSQL.

A deduplicação GraphQL usa a chave existente de documento, variáveis e operação, dentro da mesma instância de engine/pool. Falhas não preenchem o cache e liberam a chave. Desativar o cache de respostas com TTL ou orçamento zero também desativa essa deduplicação, preservando a medição do caminho sem cache. Requisições que compartilham uma execução recebem seu resultado como `MISS`; `HIT` continua significando resposta encontrada no cache concluído.

## Evidência local

Execute `npm run benchmark:local` no Node 22 com o snapshot gerado. O comando grava `contracts/local.performance.json`, verifica os conteúdos das respostas e mede 100 requisições REST após dez aquecimentos. Os mesmos bytes de assets ficam em memória nos dois cenários, isolando o custo de interpretação e reutilização. O cenário frio usa bindings novos por requisição para reproduzir a duração anterior dos objetos interpretados; não é uma comparação entre dois binários de produção.

Na execução registrada:

| Cenário REST | Mediana | p95 | Leituras de assets em 100 requisições |
| --- | ---: | ---: | ---: |
| Cache de objetos frio por requisição | 4,266 ms | 6,642 ms | 300 |
| Cache de objetos aquecido | 1,603 ms | 2,014 ms | 0 |

A mediana caiu aproximadamente 62% nesse cenário local. A serialização da resposta continua sendo necessária. O ganho depende do tamanho do shard, da repetição de acesso e da taxa de acertos; páginas grandes e arquivos que excedem o orçamento não terão o mesmo resultado.

Para GraphQL, o benchmark utiliza um pool simulado com atraso de 5 ms: 32 operações simultâneas idênticas passaram de 32 chamadas SQL para uma. Esse resultado comprova a eliminação de trabalho duplicado; seus tempos não estimam desempenho PostgreSQL ou capacidade do pool de produção. Os testes também verificam nova tentativa após falha, isolamento de variáveis, cache desativado, isolamento de domínios/bindings/versões, evicção e arquivos grandes.

`npm test`: 18 testes aprovados no Node 22.23.4. O teste HTTP requer permissão para abrir uma porta local. O Node 26.10.0 disponível no ambiente apresentou falha nativa no teste HTTP; a validação foi concluída com o Node 22 utilizado pela CI.

## Pontos preservados e próximos alvos de medição

- O compilador já reúne campos raiz em uma chamada SQL e resolve relações dentro do SQL, evitando uma chamada de rede por relação. Subconsultas correlacionadas ainda podem custar caro em consultas profundas: medir `EXPLAIN (ANALYZE, BUFFERS)` para consultas reais antes de alterar índices ou joins.
- Na primeira análise, agregações usavam CTE `MATERIALIZED` e seleção de todas as colunas. Para tabelas grandes com JSON, avaliar projeção de colunas e materialização condicional. A alteração precisa preservar `distinct_on`, ordenação, `nodes` e agregações do contrato; não foi aplicada sem planos e medições de banco.
- Na primeira análise, o importador usava `COPY` e índices das migrations Django, sem `ANALYZE` explícito após a carga; avaliar estatísticas antes da primeira carga de tráfego em um banco recém-importado, especialmente antes do benchmark. Não foram alterados índices nem banco nesta tarefa.
- O pool de quatro conexões e a execução sequencial de lotes limitam a pressão no PostgreSQL. Aumentar concorrência sem medir espera no pool pode piorar p95 e memória em hospedagem pequena.
- O cache da borda já evita boa parte das chamadas repetidas, mas o novo cache REST também beneficia o Node sem CDN, HEAD, misses e paginações diferentes que acessam o mesmo índice. Não foi adicionado outro cache integral de respostas, para evitar duplicação de grandes payloads em memória.
- Recomenda-se medir em produção acertos dos caches, consultas compartilhadas, duração e espera no pool, p95 por classe de consulta e RSS sob carga variada antes de ajustar os orçamentos. Esta alteração adiciona contagem de compartilhamento GraphQL; não instala infraestrutura externa de observabilidade.

Na primeira rodada, `DATABASE_URL` e `REFERENCE_GRAPHQL_URL` não estavam configuradas. O benchmark real PostgreSQL/Hasura e a suíte comparativa completa não foram reexecutados. O relatório anterior `contracts/backend.performance.json` foi preservado naquela rodada e atualizado na segunda; os novos números estão em um arquivo separado. Nenhuma medição local inclui TLS, CDN, suspensão dos provedores ou cold start de produção.

---
name: pokeapi-sync
description: Checar e sincronizar poke-api-komplete com a master de PokeAPI/pokeapi desde o commit da última sincronização, preservando traduções e adaptações locais.
---

Use no repositório poke-api-komplete (identificado por upstream.lock.json e scripts/sync_upstream.py). Se instalado globalmente, os scripts continuam sendo os do repositório atual.

Execute `python3 scripts/sync_upstream.py` para checar. O script compara o SHA registrado com a master oficial, lista commits/arquivos novos e registra last_checked_at/last_checked_commit. Datas são UTC; o SHA, e não um filtro por data, delimita as mudanças. Uma checagem sem novidades não altera last_synced_at. Não faça fetch/merge da master oficial na raiz: o upstream está em vendor/pokeapi, e o restante é implementação própria.

Se o usuário pedir apenas checagem, reporte as mudanças e encerre. Se pedir atualização/sincronização, execute `python3 scripts/sync_upstream.py --apply`. Ele exige vendor e lock sem mudanças pendentes, verifica ancestralidade e aplica somente o diff entre os dois SHAs. Adaptações locais já versionadas são preservadas quando não conflitam; conflitos interrompem a aplicação. Não use reset/clean/checkout para descartar trabalho. Para conflitos, faça uma integração de três vias em diretório temporário usando o commit antigo, a cópia local e o novo commit; revise a resolução antes de alterar o vendor. Não avance o SHA em uma atualização parcial.

Alterações de submódulos exigem revisão manual: cries tem snapshot e cries_commit próprios; sprites usa data/v2/manifest.json.gz e sprites_manifest_sha256. O script interrompe --apply nesse caso. Atualize cada snapshot a partir da revisão oficial correspondente, preserve licenças, confira hash/commit e só então avance o lock. Não baixe o repositório inteiro de sprites. Não execute código recebido antes de revisar o diff.

Após aplicar, revise mudanças em modelos, CSVs, importador, dependências e contratos. Preserve data/translations, scripts/localization.py e a implementação própria. Instale dependências conforme README, gere os dados com `npm run data:build` e execute `npm run test:translations`, `npm test` e `npm run build`. Para mudanças em modelos/GraphQL/SQL, use também as verificações de compatibilidade com PostgreSQL/Hasura descritas no README. Não regenere contratos a partir do backend candidato. Corrija cobertura das traduções quando surgirem novos registros.

O script remove SQLite e marcador de cache ao aplicar: isso afeta apenas o snapshot local regenerável. last_synced_at significa sincronização dos fontes, não publicação ou validação do snapshot. Após todas as verificações necessárias passarem, acrescente ao lock `last_validated_commit` com o SHA e `last_validated_at` em UTC. Em caso de falha, não avance esses campos e informe o que falta. Nunca apresente uma sincronização de fontes como atualização do banco de produção.

Se a rede falhar, não registre checagem bem-sucedida. Uma reescrita de histórico ou conflitos exigem análise, sem sobrescrever o vendor. Não publique, faça push, importe banco remoto ou implante sem solicitação correspondente. Relate SHAs anterior/novo, datas, alterações relevantes, testes e pendências. Se não houver mudanças, informe que a base continua atualizada.

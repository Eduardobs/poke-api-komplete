# Descrições em português brasileiro

Os arquivos deste diretório complementam os dados vendorizados, usando o idioma
`pt-br` (ID 13). As traduções são aplicadas ao SQLite antes de gerar o REST e de
importar o PostgreSQL para GraphQL. Não há consulta a serviços de tradução no
build nem durante requisições da API.

Os arquivos `move*.pt-br.txt` contêm os resumos de golpes mantidos pelo projeto.
Os arquivos `resources/*.json` contêm traduções automáticas dos textos ingleses
dos demais recursos, inicialmente produzidas com Google Tradutor (`en` → `pt-BR`).
Descrições com quebras de linha foram retraduzidas com o modelo local
`gemma4:e4b`, unindo as frases antes da tradução. Os textos receberam ajustes de
terminologia e revisão por amostragem. Não são traduções oficiais
da franquia. Nomes próprios de Pokémon, golpes, habilidades e itens são mantidos
como nos campos de nome em inglês da API.

Cada arquivo JSON corresponde a um modelo relacional. `key` identifica o recurso
e, quando aplicável, sua versão; `text` contém os campos traduzidos. Para textos
que variam por jogo, é selecionada a versão inglesa de lançamento mais recente,
sem substituir os registros dos outros idiomas. Descrições de efeitos e de
alterações históricas são traduzidas separadamente. Os nomes de espécies são
copiados do inglês para acompanhar o campo traduzido `genus`.

`source_sha256` registra os textos e as chaves do snapshot original. O build
rejeita arquivos incompletos, fontes alteradas, campos vazios quando o original
contém texto e textos maiores que os limites dos modelos. Ao atualizar o
upstream, exporte novamente as fontes para atualizar as traduções e seus hashes:

```sh
vendor/pokeapi/.venv/bin/python scripts/localize_resources.py --export-sources /tmp/translation-sources.json
```

Depois de editar uma tradução, execute `npm run data:build` e `npm test`.
Para atualizar um PostgreSQL existente, siga o processo de importação em banco
vazio descrito no README principal.

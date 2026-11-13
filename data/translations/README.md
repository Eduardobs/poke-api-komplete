# Traduções dos recursos

Todas as traduções usam um único formato e um único pipeline em
`scripts/localization.py`. Golpes, habilidades, espécies, itens, formas, Pokédex
e demais descrições seguem as mesmas etapas de descoberta de fontes, validação
e gravação. Os textos são aplicados ao SQLite antes da geração do REST e da
importação do PostgreSQL para GraphQL, sem serviços externos durante o build
ou as requisições.

## Estrutura única

`locales.json` registra cada idioma com `name`, `id`, `source_id` e `catalog`.
O caminho de `catalog` é relativo a este diretório. Cada idioma possui uma pasta,
como `pt-br/`, com um JSON por modelo relacional, inclusive `MoveFlavorText.json`
e `MoveEffectEffectText.json` para golpes:

```json
{
  "source_sha256": "hash das fontes exportadas para este modelo",
  "entries": [
    {
      "key": {"ability_id": 1},
      "text": {"effect": "Texto completo", "short_effect": "Resumo"}
    }
  ]
}
```

`key` identifica o recurso e, quando aplicável, a versão; `text` contém os campos
traduzidos. As fontes são descobertas pelos campos dos modelos. Para descrições
que variam por jogo, o pipeline inclui todas as versões com texto no idioma de
origem.
Nomes próprios de espécies são copiados da origem para acompanhar `genus`.

`sources.json` registra fontes complementares para descrições que não existem no
upstream. Cada entrada usa `key`, `source` e `copy`, como as fontes exportadas.
Um campo vazio em `source` indica ausência de texto original. Atualmente são
23 descrições de golpes já mantidas pelo projeto. Essas entradas passam pelo
mesmo fluxo dos demais recursos, com validação de chaves, referências, campos,
hash e textos; não há seleção especial de versões nem montagem de resumos para
golpes durante o build. As versões dessas fontes são explícitas no catálogo.

## Adicionar ou atualizar traduções

1. Cadastre o idioma nos dados de origem (`Language`) e em `locales.json`.
2. Exporte as fontes pelo comando comum abaixo, usando `--locale NOME` para
   selecionar o idioma registrado.
3. Crie os JSONs no diretório do idioma seguindo o formato comum, preservando as
   chaves e calculando `source_sha256` com `source_hash` de `scripts/localization.py`.
4. Execute o teste de traduções e gere novamente os dados.

```sh
vendor/pokeapi/.venv/bin/python scripts/localization.py --locale pt-br --export-sources /tmp/translation-sources.json
npm run test:translations
npm run data:build
npm test
```

O hash usa SHA-256 do JSON das fontes do modelo com `ensure_ascii=False` e
`sort_keys=True`, conforme `source_hash`. A validação rejeita cobertura incompleta,
fontes alteradas, campos vazios quando há texto original, mudanças em placeholders,
tokens não resolvidos e textos acima dos limites do banco. O padrão se aplica
também aos resumos dos golpes. Não é necessário criar scripts por recurso.

A aplicação ocorre em uma transação para todos os idiomas, com uma leitura dos
registros de destino por modelo e gravações em lotes de até 250 registros.
Textos inalterados não geram atualizações e os IDs existentes são preservados.
REST mantém seus shards estáticos; GraphQL usa as tabelas importadas e seus
filtros e caches existentes. Para atualizar um PostgreSQL existente, siga o
processo de importação em banco vazio no README principal.

## Seleção pelos consumidores

REST expõe o idioma em `language.name`; GraphQL oferece `language_id` e a relação
`language`. Consulte `/api/v2/language/` para descobrir idiomas. Quando um texto
não estiver disponível, o consumidor pode buscar explicitamente o idioma de
origem como alternativa. Para textos históricos, selecione também a versão
pretendida: as traduções preservam a chave `version_id` ou `version_group_id`
de cada fonte.

| Recurso | Campos REST | Modelos relacionais do GraphQL |
| --- | --- | --- |
| Habilidades | `effect_entries`, `flavor_text_entries`, `effect_changes` | `AbilityEffectText`, `AbilityFlavorText`, `AbilityChangeEffectText` |
| Espécies | `flavor_text_entries`, `genera`, `form_descriptions` | `PokemonSpeciesFlavorText`, `PokemonSpeciesName`, `PokemonSpeciesDescription` |
| Itens | `effect_entries`, `flavor_text_entries` | `ItemEffectText`, `ItemFlavorText` |
| Formas e formatos | `flavor_text_entries`, `names` | `PokemonFormFlavorText`, `PokemonShapeName` |
| Pokédex | `descriptions` | `PokedexDescription` |
| Golpes | `effect_entries`, `flavor_text_entries` | `MoveEffectEffectText`, `MoveFlavorText` |

Os campos GraphQL seguem `contracts/graphql.schema.graphql`, por exemplo
`abilityeffecttexts`, `pokemonspeciesflavortexts` e `moveflavortexts`.

Para buscar os resumos de habilidades em português brasileiro, envie ao
`/v1beta2` a consulta abaixo com `{"ids":[1,9,314],"languages":["pt-br"]}`:

```graphql
query AbilityListDetails($ids: [Int!]!, $languages: [String!]!) {
  ability(where: { id: { _in: $ids } }) {
    id
    name
    abilityeffecttexts(where: { language: { name: { _in: $languages } } }) {
      short_effect
      language { name }
    }
  }
}
```

## Origem dos textos existentes

Os resumos dos 937 golpes em português brasileiro são mantidos pelo projeto.
Os textos dos demais recursos foram inicialmente produzidos com Google Tradutor
(`en` → `pt-BR`); descrições com quebras de linha foram retraduzidas com o modelo
local `gemma4:e4b`. Houve ajustes de terminologia e revisão por amostragem.
Não são traduções oficiais da franquia. Os nomes próprios continuam vindos do
upstream; os resumos de golpes não são traduções integrais dos efeitos longos.

Os 314 resumos de habilidades (`AbilityEffectText.short_effect`) foram
retraduzidos do inglês com o modelo local `gemma4:e4b` via Ollama. Os efeitos
completos e os textos históricos mantêm as traduções anteriores. As mecânicas
descritas na fonte são preservadas, inclusive quando se referem a jogos antigos.

As descrições históricas ausentes foram traduzidas com `gemma4:e4b` local e
Google Tradutor (`en` → `pt-BR`), usando somente textos públicos dos CSVs do
PokeAPI no serviço externo. Foram reutilizadas traduções para fontes idênticas
após normalização de espaços. Os textos pt-BR já existentes foram preservados.
A cobertura inclui todas as versões
com fonte em inglês, além das fontes complementares mantidas pelo projeto.

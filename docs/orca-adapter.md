# Conectar um adaptador de terminal

O pacote inclui um adaptador de subprocesso local e exporta uma interface com
quatro operações: `start`, `wait`, `isIdle` e `close`. Ele não inclui uma integração
operacional com a API do aplicativo Orca. Este documento descreve o contrato dessa
integração, sem presumir uma versão específica instalada por outra pessoa.

## Contrato

| Operação | Responsabilidade |
| --- | --- |
| `start(request)` | Abrir uma sessão na `cwd` indicada, com comando, entrada e ambiente do worker; devolver um handle associado a `request.owner` |
| `wait(handle)` | Esperar o comando terminar e devolver seu código de saída real |
| `isIdle(handle)` | Consultar estado autoritativo da sessão e confirmar ausência de trabalho em execução |
| `close(handle)` | Fechar somente aquela sessão, depois de conferir ownership e estado ocioso |

Guarde os handles criados pelo próprio adaptador. Um ID recebido de fora não é
prova de ownership. No adaptador local, a identidade do objeto também é conferida,
impedindo que um objeto reconstruído com o mesmo ID seja tratado como sessão própria.
Fechar uma sessão que ainda está rodando deve falhar, sem interrompê-la.

## Mapeamento para Orca

Comece pelo guia da CLI instalada: `orca skills get orca-cli --json`. Consulte
`orca terminal create --help`, `orca terminal show --help`,
`orca terminal wait --help` e `orca terminal close --help` antes de implementar.
Os nomes abaixo descrevem o mapeamento; não são um adaptador pronto para copiar.

- `start`: use `orca terminal create` com um workspace correspondente a `request.cwd`.
  Resolva e registre o handle retornado, sem reutilizar um terminal escolhido pelo
  título. Worktrees Git externas podem precisar de registro explícito no Orca.
- `wait`: acompanhe a execução pelo estado/recibo da API e pelo código de saída.
  A presença de um prompt ou de texto `FIM` no terminal não comprova sucesso.
- `isIdle`: confirme estado ocioso no runtime. Se a API estiver indisponível ou o
  estado não puder ser verificado, mantenha a sessão aberta e retorne erro.
- `close`: chame `orca terminal close --terminal <handle>` somente para um handle
  criado por essa execução. Não use fechamento em lote nem feche resultados de uma
  listagem geral de terminais.

O runner passa comando como array argv. Se uma API de terminal exigir uma string
de shell, a conversão precisa de escaping específico da plataforma ou de um
entrypoint fixo que receba um arquivo de configuração. Concatenar SPEC, paths ou
argumentos numa string executável introduz uma fronteira de interpretação nova.

Forneça o adaptador pelo uso programático: construa `Config` e chame
`gestor(config, adapter)`. A CLI padrão mantém somente o adaptador local. Não há
carregamento automático de plugins ou código arbitrário de configuração.

## O que testar antes de usar a integração

Teste primeiro num projeto descartável: dois handles da execução atual, um handle
de outra execução, uma sessão ocupada e uma falha na consulta de estado. Só os
handles próprios confirmados como ociosos podem ser fechados. Teste também worker
com saída não zero e resultado ausente, sem tratar a conclusão da chamada à API
como conclusão do trabalho.

Persistência e retomada requerem um protocolo adicional de ownership e revalidação
do runtime. Reaproveitar um PID ou um handle antigo depois de reinício não é seguro.
O adaptador local evita essa ambiguidade ao manter o lifecycle na mesma execução.

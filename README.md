# Laboratorio Vercel + n8n

Laboratorio minimo para validar integracao sincrona e assincrona entre a Vercel
e o n8n, servindo de base para o futuro fluxo real de geracao de documentos do
SimplesVende.

## Estrutura

```
/
├── index.html          # frontend unico (HTML + CSS + JS puro)
└── api/
    ├── n8n.ts           # Vercel Function: proxy autenticado Vercel -> n8n
    └── callback.ts      # Vercel Function: recebe (POST) e consulta (GET) callbacks do n8n
```

## 1. Variaveis de ambiente

Copie `.env.example` para `.env.local` (uso local com `vercel dev`) e configure
os mesmos nomes em Project Settings > Environment Variables na Vercel:

| Variavel | Uso |
|---|---|
| `N8N_WEBHOOK_URL` | URL de producao do webhook do n8n |
| `N8N_OUTBOUND_SECRET` | Enviado como `Authorization: Bearer ...` da Vercel para o n8n |
| `VERCEL_CALLBACK_SECRET` | Exigido no `Authorization: Bearer ...` que o n8n envia para `/api/callback` |

Alteracoes nessas variaveis na Vercel exigem um novo deployment para valer.

## 2. Persistencia (sem banco de dados)

Este laboratorio nao usa Supabase nem qualquer banco externo:

- **`/api/callback`** guarda o evento recebido do n8n em um `Map` em memoria,
  dentro do processo da Function. Isso e suficiente para a ponte curta entre
  o POST do n8n e o proximo GET de polling do frontend (o `Wait` do workflow
  e de poucos segundos). E o modelo "Nivel 1" deste tipo de laboratorio:
  valido para testar conectividade, mas **nao e um armazenamento duravel** —
  uma instancia fria ou outra regiao da Vercel nao enxerga o mesmo mapa. Para
  o fluxo real de producao (DocumentEngine), isso devera migrar para um banco.
- **`index.html`** guarda o historico de eventos e o ultimo estado de cada
  cartao no `localStorage` do navegador (chave `n8n-lab-state-v1`), para que
  um F5 na pagina nao apague o que ja foi testado. Se houver um callback
  assincrono pendente no momento do reload, o polling e retomado
  automaticamente.

## 3. Workflow no n8n

Criar um unico workflow com:

```
Webhook (POST /webhook/vercel-integration-lab)
   -> valida Authorization: Bearer <N8N_OUTBOUND_SECRET>
   -> Switch por body.operation
        confirm         -> Respond to Webhook (echo + correlationId)
        transform       -> Set/Code (novo JSON preservando correlationId) -> Respond to Webhook
        notify          -> gera aviso (log/HTTP/mensagem) -> Respond to Webhook com notificationId
        async-callback  -> Respond to Webhook { status: "queued", jobId } (responder ANTES do Wait)
                         -> Wait (~5s)
                         -> HTTP Request POST para VERCEL_CALLBACK_URL (.../api/callback)
                            header Authorization: Bearer <VERCEL_CALLBACK_SECRET>
                            body: { eventId, eventType, correlationId, jobId, status, occurredAt, data }
```

Publicar o workflow e usar a URL de **producao** (nao a URL de teste) em
`N8N_WEBHOOK_URL`.

## 4. Contrato compartilhado

Requisicao Vercel -> n8n:
```json
{
  "schemaVersion": "1.0",
  "operation": "confirm | transform | notify | async-callback",
  "correlationId": "uuid",
  "sentAt": "ISO-8601",
  "source": "vercel-lab",
  "payload": {}
}
```

Resposta imediata (normalizada por `/api/n8n` antes de voltar ao navegador):
```json
{
  "success": true,
  "operation": "...",
  "correlationId": "uuid",
  "receivedAt": "ISO-8601",
  "status": "...",
  "data": {},
  "error": null
}
```

Callback assincrono (n8n -> `/api/callback`):
```json
{
  "eventId": "uuid",
  "eventType": "async-callback",
  "correlationId": "uuid",
  "jobId": "...",
  "status": "completed",
  "occurredAt": "ISO-8601",
  "data": {}
}
```

## 5. Rodando local

```bash
npm install
vercel dev
```

Abra `http://localhost:3000` e use os 4 cartoes da interface.

## 6. Seguranca

- O navegador so fala com rotas do proprio dominio (`/api/*`); nenhum segredo
  ou URL do n8n fica exposto no frontend.
- `N8N_OUTBOUND_SECRET` autentica Vercel -> n8n; `VERCEL_CALLBACK_SECRET`
  autentica n8n -> Vercel. Sao credenciais independentes.
- Callbacks sao deduplicados por `eventId` antes de serem gravados no `Map` em memoria.
- Corpo das requisicoes limitado a 100 KB; chamadas ao n8n tem timeout de 10s.

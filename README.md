# Midnight Books — API

Monólito modular em Node.js, TypeScript e NestJS com PostgreSQL. O catálogo contém 12 títulos reais e 14 edições de demonstração, com capas conceituais, preços e estoque fictícios. Os pedidos são vinculados à conta autenticada. A reserva de estoque continua atômica para todos os itens da sacola.

## Executar com Docker

Mantenha os repositórios em pastas irmãs, com os nomes atuais. A partir deste repositório:

```sh
node scripts/setup-docker.mjs
docker compose up --build -d --wait
```

| Serviço | Endereço local |
| --- | --- |
| Loja | http://localhost:3000 |
| API | http://localhost:4100/v1 |
| Caixa de e-mail de desenvolvimento | http://localhost:8025 |
| PostgreSQL | 127.0.0.1:55434 |

O arquivo .env contém a senha do PostgreSQL e as chaves individuais da equipe. O script preserva configurações existentes. Entre no PostgreSQL com o usuário midnight e a base midnight, usando POSTGRES_PASSWORD. O painel da livraria utiliza a chave da pessoa identificada em STAFF_KEYS.

O Compose cria uma base demonstrativa nova e mantém os dados no volume postgres_data. Para parar, use docker compose down. Para atualizar, execute docker compose up --build -d --wait. O volume é preservado entre reinicializações.

## Acesso por e-mail

Abra a loja, adicione livros e entre com um e-mail. O Mailpit recebe a mensagem localmente. Abra a caixa em http://localhost:8025, copie o link da mensagem e confirme o acesso na loja. O link expira em 15 minutos e só pode ser utilizado uma vez. A sessão dura sete dias, usa cookie HttpOnly e é revogada ao sair. A sacola permanece no navegador.

A API exige sessão para iniciar pagamentos, consultar pedidos e concluir o pagamento demonstrativo. O e-mail do pedido vem da conta autenticada. Cada cliente acessa apenas seus próprios pedidos. Solicitações de link têm limite por endereço de e-mail e IP. O navegador consulta a API diretamente, com CORS limitado ao endereço configurado em STOREFRONT_URL.

## Configuração comercial e implantação

A demonstração utiliza português do Brasil, BRL e entregas no Brasil. O frete demonstrativo é R$ 4,95 e pode ser alterado com SHIPPING_CENTS. Os preços incluem os tributos aplicáveis. O pagamento atual é simulado.

A imagem pode ser executada com NODE_ENV=production, DATABASE_URL, STOREFRONT_URL HTTPS, STAFF_KEYS, PAYMENT_MODE=stripe, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SHIPPING_COUNTRY=BR, SHIPPING_CENTS, RESEND_API_KEY e MAIL_FROM. Configure um domínio remetente verificado no Resend para receber os links de acesso em caixas reais. Mailpit é a caixa de testes local.

Use origens HTTPS do mesmo site, por exemplo loja.exemplo.com e api.exemplo.com, para o cookie SameSite=Lax. A API aceita a origem exata de STOREFRONT_URL. O webhook do Stripe utiliza /v1/payments/webhook e verifica a assinatura do corpo original. Ative checkout.session.completed e checkout.session.expired. Configure limites de tráfego no proxy de entrada.

O worker reconcilia reservas vencidas e envia confirmações com repetição segura. O endpoint /v1/health sinaliza reservas atrasadas e problemas na fila de e-mail. Configure backups do volume ou do PostgreSQL gerenciado conforme a implantação.

## Contrato e testes

O contrato OpenAPI é contract/openapi-1.1.0.json. O frontend mantém uma cópia dessa versão.

```sh
npm ci
npm test
```

A suíte usa uma instância PostgreSQL temporária e isolada para testar concorrência pelo último exemplar, falha parcial, repetição de pagamentos, restauração, links de uso único e isolamento entre clientes. A aplicação cotidiana usa o PostgreSQL do Compose.

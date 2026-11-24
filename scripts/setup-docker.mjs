import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
const staff=randomBytes(32).toString('hex');
try {
 await writeFile('.env',[
  'POSTGRES_PASSWORD='+randomBytes(32).toString('hex'),
  'STAFF_KEYS='+JSON.stringify({livreiro:staff}),
  'STOREFRONT_URL=http://localhost:3000',
  'NEXT_PUBLIC_API_URL=http://localhost:4100',
 ].join('\n')+'\n',{mode:0o600,flag:'wx'});
 console.log('Configuração criada em .env. Use a chave em STAFF_KEYS no painel da livraria.');
} catch(e) {if(e.code!=='EEXIST')throw e;console.log('O arquivo .env já existe. Configuração preservada.');}

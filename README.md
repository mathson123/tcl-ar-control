# TCL Ar

Controle **não oficial** dos ar-condicionados TCL pela bandeja do Windows (ao lado do relógio).
Não é da TCL, não é afiliado nem aprovado pela TCL.

## Compatibilidade

| App do celular | Funciona |
|---|---|
| TCL Home | ✅ |
| TCL Smart / Smart Life (Tuya) | ❌ |
| Intelligent AC (BroadLink) | ❌ |

Testado com split TCL Inverter. O cadastro inicial do aparelho no Wi-Fi continua sendo pelo app TCL Home.

## Instalar

Baixe `TCL-Ar-Setup-x.y.z.exe` em **Releases**. O instalador não é assinado: o Windows SmartScreen pode
avisar ("Mais informações" → "Executar assim mesmo"). Após instalar, o app abre direto no login.

- Clique esquerdo no ícone: painel com temperatura, modo, ventilação e turbo de cada ar.
- Clique direito: liga/desliga rápido, ligar/desligar todos, painel completo, iniciar com o Windows, sair.

## Desenvolvimento

```bash
npm ci
npm start                 # roda o app (bandeja)
npm start -- --demo       # 4 aparelhos falsos, sem conta
npm run selftest          # confere a assinatura AWS SigV4
node scripts/icon.mjs     # regenera build/icon.png e build/icon.ico
npm run dist              # gera o instalador em dist/
```

Publicar versão: `git tag v1.0.1 && git push origin v1.0.1` → workflow `release` gera o instalador e cria o Release.

## Como funciona

Os aparelhos TCL Home não aceitam comando pela rede local; falam só com a nuvem TCL (AWS IoT).
O app faz o mesmo caminho do celular: login TCL → credenciais AWS Cognito → lê/escreve o "shadow"
de cada aparelho. Protocolo baseado no projeto não oficial
[ha-tcl-home-unofficial-integration](https://github.com/nemesa/ha-tcl-home-unofficial-integration).
Pode parar de funcionar se a TCL mudar o serviço.

Sessão em `%APPDATA%\tcl-ar\session.json` (e-mail + MD5 da senha, que é o que a API TCL recebe).
"Sair" apaga. O servidor interno só escuta em `127.0.0.1:8765`.

## Segurança (CI)

- `security`: gitleaks (segredos no histórico, binário com checksum verificado), `npm audit` (falha em high+),
  checagem de sintaxe e self-test. Roda em push na `main`, PR e antes de todo release.
- Actions fixadas por SHA; Dependabot atualiza npm e actions toda semana.

# Despliegue — Church Translator

Producción actual: VM de GCP (`translator-vm`), código en `/opt/translator`,
corriendo como servicio systemd `translator.service` (usuario `g1josue9`).

## Actualizar a una nueva versión (lo habitual)

```bash
# en la VM:
cd /opt/translator
git pull
npm ci
npm run build
sudo systemctl restart translator
```

Verificar que quedó la versión nueva:

```bash
systemctl status translator | head -5      # active (running)
ps aux | grep ffmpeg | grep -v grep        # los flags de ffmpeg delatan la versión
journalctl -u translator -n 30             # logs si algo falla
```

Notas:
- Una actualización de solo código no requiere tocar `.env` (está en
  `/opt/translator/.env`: `OPENAI_API_KEY`, `PORT`, `TARGET_LANGUAGE`,
  `PUBLIC_HOST`).
- Los teléfonos con la página del oyente abierta deben **recargarla una vez**
  tras el despliegue para tomar el JavaScript nuevo (no hay service worker).

## Montar una VM desde cero (referencia)

> **HTTPS es obligatorio.** Sin HTTPS el navegador bloquea el micrófono del
> operador (`getUserMedia` exige contexto seguro) y el Wake Lock en iOS no
> funciona. Hace falta IP estática + dominio con registro A hacia la VM.

### 1. Node 20 y git

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

No hace falta instalar ffmpeg: va incluido en el paquete `ffmpeg-static`.

### 2. Clonar y compilar

```bash
sudo mkdir -p /opt/translator && sudo chown $USER /opt/translator
git clone https://github.com/HectorDavila/translator.git /opt/translator
cd /opt/translator
npm ci && npm run build
```

### 3. Variables de entorno

```bash
cp .env.example .env && nano .env
```

```
OPENAI_API_KEY=sk-...
PORT=3000
TARGET_LANGUAGE=es
PUBLIC_HOST=tu-dominio.com     # el QR apuntará aquí
```

### 4. Servicio systemd

`/etc/systemd/system/translator.service`:

```ini
[Unit]
Description=Church Translator
After=network.target

[Service]
WorkingDirectory=/opt/translator
ExecStart=/usr/bin/node --max-old-space-size=768 dist/server/index.js
Restart=always
RestartSec=3
User=g1josue9

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now translator
```

### 5. HTTPS con Caddy

Caddy obtiene y renueva el certificado de Let's Encrypt solo, y proxya los
WebSockets sin configuración extra.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
tu-dominio.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl restart caddy
```

### 6. Firewall de GCP

```bash
gcloud compute firewall-rules create allow-web --allow tcp:80,tcp:443 --target-tags=http-server
gcloud compute instances add-tags translator-vm --tags=http-server --zone=TU-ZONA
```

El puerto 3000 no se abre al exterior: Caddy (443) hace de proxy.

### 7. Prueba final

1. `https://tu-dominio.com/operator.html` — debe pedir permiso de micrófono.
2. `https://tu-dominio.com/listener.html` en un teléfono — **Conectar**,
   bloquear pantalla y confirmar que el audio sigue.
3. `https://tu-dominio.com/qr.html` — QR para proyectar.

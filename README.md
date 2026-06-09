# Parkcol Real Demo

Demo funcional aislado para Parkcol:

- Camara del navegador para captura.
- Registro de ingreso por placa.
- QR real para pago simulado.
- Pagina de pago compartida entre dispositivos.
- Validacion de salida.
- Dashboard de caja/cierre.
- Base Postgres si `DATABASE_URL` existe; fallback en memoria para desarrollo local.

## Local

```bash
npm install
npm run dev
```

Abrir `http://localhost:3000`.

## Produccion

Variables esperadas:

- `DATABASE_URL`: Postgres aislado del demo.
- `PUBLIC_BASE_URL`: URL publica, por ejemplo `https://demo-parkcol.solversai.cloud`.
- `OPENAI_API_KEY`: opcional, solo para capa visual IA. No es necesaria para el MVP.

## Dokploy

Crear app Node/Docker con este directorio como root.

Crear Postgres aislado para Parkcol y pasar su connection string como `DATABASE_URL`.

No usar Mission Control ni Supabase principal para este demo.

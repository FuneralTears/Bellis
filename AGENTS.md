# Bellis: sincronización visual de producto y demo

Estas instrucciones se aplican a todo el repositorio y a cada fase visual.

## Regla permanente

Todo cambio visual en Dashboard, Agenda, Pacientes, Seguimientos,
Automatizaciones, Notificaciones, Formularios, Landing, Booking público o Auth
debe reflejarse también en `/demo` dentro de la misma tarea.

Si cambia una pantalla real, actualizar su equivalente en demo. Si se crea un
componente visual, reutilizarlo también en demo cuando aplique. Una fase visual
sin su correspondiente actualización de demo está incompleta.

## Showroom independiente

- Usar únicamente datos mock en la demo.
- No conectar la demo a Supabase ni a datos reales.
- La demo debe funcionar sin autenticación ni sesión.
- No ejecutar pagos, reservas ni automatizaciones reales desde la demo.
- Reutilizar componentes reales cuando sea seguro y no introduzcan dependencias
  de datos, sesión o acciones reales.
- Evitar duplicar estilos; compartir los componentes, tokens y estilos visuales
  del producto cuando sea seguro.
- Mantener la demo visualmente alineada con producción, sin inventar una
  dirección visual diferente.

La navegación de `/demo` debe permitir recorrer Dashboard, Agenda, Pacientes,
Seguimientos, Automatizaciones, Notificaciones y Formularios sin autenticación.

## Validación de cada fase visual

- Validar también la demo en navegador a 1440, 768, 390 y 320 px.
- Ejecutar TypeScript y build.
- Reportar qué cambió en el producto real, qué se reflejó en demo, las
  diferencias intencionales entre real y demo y los resultados de TypeScript
  y build.
- Si una validación no se pudo realizar, indicarlo expresamente; no reportarla
  como completada.

## Alcance

No hacer cambios adicionales fuera del alcance de cada fase. La sincronización
de la demo no autoriza cambios en Supabase, migraciones, Auth, lógica de negocio,
reservas, pagos, automatizaciones, variables de entorno o infraestructura.
Respetar las restricciones y autorizaciones de la tarea concreta.

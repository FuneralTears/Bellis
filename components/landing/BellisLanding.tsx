"use client";

import { useRef, useState } from "react";
import {
  ArrowRight,
  BellRing,
  CalendarCheck,
  CalendarDays,
  Check,
  Clock3,
  CreditCard,
  FileText,
  ImageIcon,
  ListChecks,
  Menu,
  Settings2,
  Users,
  X,
} from "lucide-react";
import BellisLogo from "@/components/brand/BellisLogo";
import "./landing.css";

/**
 * Final hero photo (warm consulting room, desk, laptop showing Bellis, plant,
 * natural light). Set to its public path once the asset exists, for example
 * "/landing/consultorio.jpg". While null, a neutral placeholder is shown.
 */
const HERO_PHOTO: string | null = null;

const heroBenefits = [
  [CalendarCheck, "Turnos online"],
  [CreditCard, "Cobro antes del turno"],
  [BellRing, "Recordatorios automáticos"],
] as const;

const benefits = [
  [
    Clock3,
    "Recuperá tiempo",
    "Menos mensajes para coordinar. Más espacio para atender.",
  ],
  [
    ListChecks,
    "Llegá con todo listo",
    "Datos, preconsulta y pago organizados antes del turno.",
  ],
  [
    Users,
    "Acompañá mejor",
    "Una experiencia clara para tus pacientes, de principio a fin.",
  ],
] as const;

const steps = [
  [
    "01",
    "Completá la preconsulta",
    "Tu paciente comparte sus datos y responde las preguntas que configuraste.",
  ],
  ["02", "Realizá el pago", "El pago se realiza antes de elegir un horario."],
  [
    "03",
    "Reservá el turno",
    "Tu paciente elige entre los horarios disponibles según tus reglas.",
  ],
  [
    "04",
    "Recibí todo listo",
    "Vos encontrás el turno, las respuestas y el pago en Bellis.",
  ],
] as const;

const features = [
  [
    CalendarDays,
    "Agenda",
    "Organizá tus turnos y revisá tu día, semana o mes de un vistazo.",
    "sage",
  ],
  [
    Users,
    "Pacientes",
    "Encontrá los datos y el historial de cada paciente en un solo lugar.",
    "blue",
  ],
  [
    FileText,
    "Preconsulta",
    "Configurá las preguntas que necesitás hacer antes de atender.",
    "lilac",
  ],
  [
    CreditCard,
    "Cobros",
    "Revisá los pagos y su estado antes de cada turno.",
    "orange",
  ],
  [
    ListChecks,
    "Seguimientos",
    "Mantené a mano las tareas y oportunidades para volver a contactar.",
    "coral",
  ],
  [
    Settings2,
    "Automatizaciones",
    "Configurá reglas y consultá sus ejecuciones recientes.",
    "sage",
  ],
] as const;

/** Static product sample, shared by the public landing and its demo. */
function LandingVisual() {
  return (
    <figure className="landing-visual">
      {HERO_PHOTO ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="landing-photo"
          src={HERO_PHOTO}
          alt="Consultorio cálido con escritorio, planta y una laptop mostrando Bellis"
        />
      ) : (
        <div
          className="landing-photo-placeholder"
          role="img"
          aria-label="Espacio reservado para la foto final de un consultorio cálido, con escritorio, laptop con Bellis, planta y luz natural"
        >
          <ImageIcon size={34} strokeWidth={1.2} aria-hidden="true" />
          <span>Un espacio para atender mejor.</span>
          <small>Imagen de consultorio · próximamente</small>
        </div>
      )}
      <div
        className="landing-product-sample"
        aria-label="Vista de ejemplo de Bellis"
      >
        <div className="landing-sample-heading">
          <BellisLogo />
          <span>Vista de ejemplo</span>
        </div>
        <div className="landing-sample-title">
          <strong>Tu día, en orden</strong>
          <CalendarDays size={16} aria-hidden="true" />
        </div>
        <div className="landing-sample-appointment">
          <time>09:00</time>
          <span>
            <b>Mariana López</b>
            <small>Consulta psicológica</small>
          </span>
          <span className="landing-sample-state">Confirmado</span>
        </div>
        <div className="landing-sample-appointment">
          <time>12:00</time>
          <span>
            <b>Lucía Pérez</b>
            <small>Consulta psicológica</small>
          </span>
          <span className="landing-sample-state is-pending">Pendiente</span>
        </div>
      </div>
      <figcaption>
        Más claridad en tu día. Más tiempo para tus pacientes.
      </figcaption>
    </figure>
  );
}

/** Presentation only: no session, data clients or booking/payment actions. */
export default function BellisLanding({ demo = false }: { demo?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const startHref = demo ? "/demo" : "/registro";
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="bellis-landing">
      <a className="landing-skip" href="#contenido">
        Ir al contenido
      </a>
      <header
        className="landing-header"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            closeMenu();
            menuButton.current?.focus();
          }
        }}
      >
        <div className="landing-container landing-header-inner">
          <a
            className="brand"
            href={demo ? "/demo/landing" : "/"}
            aria-label="Bellis, inicio"
          >
            <BellisLogo />
          </a>
          <nav
            id="landing-nav"
            className={`landing-nav${menuOpen ? " is-open" : ""}`}
            aria-label="Navegación principal"
          >
            <a href="#como-funciona" onClick={closeMenu}>
              Cómo funciona
            </a>
            <a href="#funciones" onClick={closeMenu}>
              Funciones
            </a>
            <a href="#profesiones" onClick={closeMenu}>
              Para quién
            </a>
            <a className="landing-mobile-entry" href={startHref}>
              Comenzar gratis
            </a>
          </nav>
          <div className="landing-header-actions">
            <a
              className="button button-light landing-entry"
              href={demo ? "/demo" : "/ingresar"}
            >
              {demo ? "Volver a la demo" : "Iniciar sesión"}
            </a>
            <a className="button button-dark landing-start" href={startHref}>
              Comenzar gratis
            </a>
            <button
              ref={menuButton}
              className="landing-menu-toggle"
              type="button"
              aria-expanded={menuOpen}
              aria-controls="landing-nav"
              aria-label={menuOpen ? "Cerrar menú" : "Abrir menú"}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
      </header>

      <main id="contenido">
        <section
          className="landing-container landing-hero"
          aria-labelledby="landing-title"
        >
          <div className="landing-hero-copy">
            <span className="landing-eyebrow">
              <span aria-hidden="true" />
              Agenda · Pacientes · Automatizaciones
            </span>
            <h1 id="landing-title">
              Menos gestión,
              <br />
              <em>más pacientes.</em>
            </h1>
            <p>
              Organizá tu consulta, automatizá tareas y brindá una experiencia
              profesional y humana a tus pacientes, todo en un solo lugar.
            </p>
            <div className="landing-hero-actions">
              <a className="button button-dark" href={startHref}>
                Comenzar gratis <ArrowRight size={16} aria-hidden="true" />
              </a>
              <a className="button button-light" href="/demo">
                Ver demo <ArrowRight size={16} aria-hidden="true" />
              </a>
            </div>
            <p className="landing-login-hint">
              {demo ? "¿Terminaste de mirar? " : "¿Ya tenés cuenta? "}
              <a href={demo ? "/demo" : "/ingresar"}>
                {demo ? "Volver a la demo" : "Iniciá sesión"}
              </a>
            </p>
            <ul className="landing-trust" aria-label="Incluye">
              {heroBenefits.map(([Icon, text]) => (
                <li key={text}>
                  <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
                  {text}
                </li>
              ))}
            </ul>
          </div>
          <LandingVisual />
        </section>

        <section
          className="landing-container landing-benefits"
          aria-label="Beneficios principales"
        >
          {benefits.map(([Icon, title, description]) => (
            <article key={title}>
              <Icon size={21} strokeWidth={1.7} aria-hidden="true" />
              <div>
                <h2>{title}</h2>
                <p>{description}</p>
              </div>
            </article>
          ))}
        </section>

        <section
          id="como-funciona"
          className="landing-section landing-how"
          aria-labelledby="landing-how-title"
        >
          <div className="landing-container">
            <div className="landing-section-heading">
              <span className="landing-kicker">Cómo funciona</span>
              <h2 id="landing-how-title">
                Un recorrido simple.
                <br />
                Todo listo antes de atender.
              </h2>
              <p>
                Compartí tu página profesional. Tu paciente completa la
                preconsulta, paga y elige un horario.
              </p>
            </div>
            <div className="landing-steps">
              {steps.map(([number, title, description]) => (
                <article key={number}>
                  <span className="landing-step-number">{number}</span>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section
          id="funciones"
          className="landing-container landing-section"
          aria-labelledby="landing-functions-title"
        >
          <div className="landing-section-heading">
            <span className="landing-kicker">Tu consultorio, conectado</span>
            <h2 id="landing-functions-title">
              Lo que necesitás,
              <br />
              en un solo lugar.
            </h2>
            <p>
              Desde el primer turno hasta el seguimiento. Herramientas claras
              para tu forma de atender.
            </p>
          </div>
          <div className="landing-features">
            {features.map(([Icon, title, description, tone]) => (
              <article key={title}>
                <span className={`landing-feature-icon tone-${tone}`}>
                  <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
                </span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </section>

        <section
          id="profesiones"
          className="landing-professions"
          aria-labelledby="landing-professions-title"
        >
          <div className="landing-container landing-professions-inner">
            <div>
              <span className="landing-kicker">Hecho para vos</span>
              <h2 id="landing-professions-title">
                Cada consultorio
                <br />
                tiene su forma de atender.
              </h2>
              <p>
                Configurá tus servicios, preguntas y disponibilidad a tu manera.
                Para profesionales que acompañan a personas, todos los días.
              </p>
            </div>
            <ul>
              {[
                "Psicología",
                "Odontología",
                "Kinesiología",
                "Nutrición",
                "Psicopedagogía",
                "Otras profesiones",
              ].map((text) => (
                <li key={text}>
                  <Check size={14} aria-hidden="true" />
                  {text}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          id="precios"
          className="landing-container landing-section landing-final"
          aria-labelledby="landing-final-title"
        >
          <div>
            <span className="landing-kicker">Empezá con Bellis</span>
            <h2 id="landing-final-title">Tu tiempo también importa.</h2>
            <p>
              Probá Bellis durante 30 días y organizá tu consultorio con más
              claridad.
            </p>
          </div>
          <div className="landing-final-actions">
            <a className="button button-dark" href={startHref}>
              Comenzar gratis <ArrowRight size={16} aria-hidden="true" />
            </a>
            <span>Sin tarjeta. Sin compromiso.</span>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-container">
          <BellisLogo />
          <span>Más tiempo para lo que importa.</span>
          <span>© 2026 Bellis</span>
        </div>
      </footer>
    </div>
  );
}

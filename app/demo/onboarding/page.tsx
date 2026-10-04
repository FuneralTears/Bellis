import type { Metadata } from "next";
import OnboardingDemo from "./onboarding-demo";

export const metadata: Metadata = { title: "Bellis — Demo de primeros pasos" };

export default function DemoOnboarding() {
  return <OnboardingDemo />;
}

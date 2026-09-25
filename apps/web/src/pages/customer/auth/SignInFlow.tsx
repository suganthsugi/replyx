import { useState } from 'react';

import { CheckEmailStep } from './CheckEmailStep';
import { EmailStep } from './EmailStep';
import { PasswordSignIn } from './PasswordSignIn';

type Step = { name: 'email' } | { name: 'check-email'; email: string } | { name: 'password' };

/**
 * Composes the customer sign-in steps (T068) into the flow the signed-out home shows: email
 * first, then "check your email", with a password option available at every step (fewest
 * possible steps, FR-012).
 */
export function SignInFlow() {
  const [step, setStep] = useState<Step>({ name: 'email' });

  if (step.name === 'password') {
    return <PasswordSignIn onBack={() => setStep({ name: 'email' })} />;
  }
  if (step.name === 'check-email') {
    return (
      <CheckEmailStep
        email={step.email}
        onChangeEmail={() => setStep({ name: 'email' })}
        onUsePassword={() => setStep({ name: 'password' })}
      />
    );
  }
  return (
    <EmailStep
      onSent={(email) => setStep({ name: 'check-email', email })}
      onUsePassword={() => setStep({ name: 'password' })}
    />
  );
}

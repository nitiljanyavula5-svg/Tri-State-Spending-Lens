import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';
import { buttonStyles, type ButtonSize, type ButtonVariant } from './buttonStyles';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant, size, className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={buttonStyles(variant, size, className)} {...rest} />;
}

interface ButtonLinkProps {
  to: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
}

/**
 * A link styled as a button. Kept distinct from `Button` on purpose: a
 * navigation target must remain an anchor so it keeps browser link semantics
 * and keyboard behaviour.
 */
export function ButtonLink({ to, variant, size, className, children }: ButtonLinkProps) {
  return (
    <Link to={to} className={buttonStyles(variant, size, className)}>
      {children}
    </Link>
  );
}

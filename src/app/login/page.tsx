"use client";

import { useActionState, useState } from "react";
import { signIn, signUp, type AuthActionState } from "./actions";

const initialState: AuthActionState = { error: null };

export default function LoginPage() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [signInState, signInAction] = useActionState(signIn, initialState);
  const [signUpState, signUpAction] = useActionState(signUp, initialState);

  const action = mode === "signin" ? signInAction : signUpAction;
  const state = mode === "signin" ? signInState : signUpState;

  return (
    <main>
      <h1>Personal Intelligence OS</h1>
      <form action={action}>
        <label>
          Email
          <input type="email" name="email" required autoComplete="email" />
        </label>
        <label>
          Mot de passe
          <input
            type="password"
            name="password"
            required
            minLength={8}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />
        </label>
        {state.error ? <p role="alert">{state.error}</p> : null}
        <button type="submit">{mode === "signin" ? "Se connecter" : "Créer un compte"}</button>
      </form>
      <button
        type="button"
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
      >
        {mode === "signin" ? "Créer un compte" : "J'ai déjà un compte"}
      </button>
    </main>
  );
}

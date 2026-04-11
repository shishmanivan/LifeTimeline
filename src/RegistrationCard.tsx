import { useState } from "react";
import { registerUserViaServer } from "./serverPersonalPhotoStorage";
import { saveRememberedBrowserUser } from "./browserUserIdentity";
import type { RememberedBrowserUser } from "./userModel";

type RegistrationCardProps = {
  onRegistered: (
    profileSlug: string,
    rememberedUser: RememberedBrowserUser | null
  ) => void;
  onBack?: () => void;
};

export function RegistrationCard({
  onRegistered,
  onBack,
}: RegistrationCardProps) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [requestedSlug, setRequestedSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedDisplayName = displayName.trim();
    const trimmedSlug = requestedSlug.trim();

    if (!trimmedEmail || !trimmedDisplayName) {
      setErrorMessage("Укажите email и отображаемое имя.");
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await registerUserViaServer({
        email: trimmedEmail,
        displayName: trimmedDisplayName,
        requestedSlug: trimmedSlug || undefined,
      });
      const rememberedUser = saveRememberedBrowserUser(result);
      onRegistered(result.profile.slug, rememberedUser);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("409")) {
        setErrorMessage("Пользователь с таким email уже существует.");
      } else if (message.includes("400")) {
        setErrorMessage("Проверьте поля формы и попробуйте ещё раз.");
      } else {
        setErrorMessage("Не удалось завершить регистрацию. Попробуйте ещё раз.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="registration-card">
      <div className="registration-card-eyebrow">Новый пользователь</div>
      <h2 className="registration-card-title">Создать учётную запись</h2>
      <p className="registration-card-copy">
        Если вы здесь впервые, зарегистрируйтесь один раз. Мы сразу создадим ваш
        профиль и переведём вас в него.
      </p>

      <form className="registration-form" onSubmit={handleSubmit}>
        <label className="registration-field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
          />
        </label>

        <label className="registration-field">
          <span>Display name</span>
          <input
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Ваше имя"
            autoComplete="nickname"
            required
          />
        </label>

        <label className="registration-field">
          <span>Slug профиля (необязательно)</span>
          <input
            type="text"
            value={requestedSlug}
            onChange={(event) => setRequestedSlug(event.target.value)}
            placeholder="my-profile"
            autoComplete="off"
          />
        </label>

        {errorMessage && (
          <p className="registration-error" role="alert">
            {errorMessage}
          </p>
        )}

        <button
          type="submit"
          className="registration-submit"
          disabled={submitting}
        >
          {submitting ? "Создание профиля…" : "Зарегистрироваться"}
        </button>
        {onBack && (
          <button
            type="button"
            className="registration-secondary-action"
            onClick={onBack}
          >
            Назад
          </button>
        )}
      </form>
    </section>
  );
}

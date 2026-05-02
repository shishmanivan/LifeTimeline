import { useState } from "react";
import { saveRememberedBrowserUser } from "./browserUserIdentity";
import {
  requestRecoveryCodeViaServer,
  verifyRecoveryCodeViaServer,
} from "./serverPersonalPhotoStorage";
import type { RememberedBrowserUser } from "./userModel";

type LoginStep = "enter_email" | "enter_code";

type RecoverAccessCardProps = {
  onRecovered: (
    profileSlug: string,
    rememberedUser: RememberedBrowserUser | null
  ) => void;
  onBack?: () => void;
};

export function RecoverAccessCard({
  onRecovered,
  onBack,
}: RecoverAccessCardProps) {
  const [loginStep, setLoginStep] = useState<LoginStep>("enter_email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleRequestCode = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setErrorMessage("Укажите email для входа или создания профиля.");
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    try {
      await requestRecoveryCodeViaServer({
        email: trimmedEmail,
      });
      setLoginStep("enter_code");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("404")) {
        setErrorMessage("Не удалось найти или подготовить профиль для этого email.");
      } else if (message.includes("400")) {
        setErrorMessage("Проверьте email и попробуйте ещё раз.");
      } else {
        setErrorMessage("Не удалось запросить одноразовый код. Попробуйте ещё раз.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedCode = code.trim();
    if (!trimmedEmail || !trimmedCode) {
      setErrorMessage("Укажите email и одноразовый код.");
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await verifyRecoveryCodeViaServer({
        email: trimmedEmail,
        code: trimmedCode,
      });
      const rememberedUser = saveRememberedBrowserUser(result);
      onRecovered(result.profile.slug, rememberedUser);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("404")) {
        setErrorMessage("Не удалось найти или создать профиль для этого email.");
      } else if (message.includes("expired-code")) {
        setErrorMessage("Одноразовый код истёк. Запросите новый код.");
      } else if (message.includes("invalid-code")) {
        setErrorMessage("Одноразовый код неверный.");
      } else if (message.includes("400")) {
        setErrorMessage("Проверьте email и одноразовый код.");
      } else {
        setErrorMessage("Не удалось подтвердить одноразовый код. Попробуйте ещё раз.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const goBackToEmail = () => {
    setLoginStep("enter_email");
    setCode("");
    setErrorMessage(null);
  };

  return (
    <section className="registration-card registration-card-secondary">
      <div className="registration-card-eyebrow">Вход</div>
      <h2 className="registration-card-title">Войти или создать профиль</h2>

      {loginStep === "enter_email" ? (
        <>
          <p className="registration-card-copy">
            Укажите email — мы отправим одноразовый код для входа в этот браузер.
          </p>
          <p className="registration-card-copy">
            Если профиля для этого email ещё нет, мы создадим его после
            подтверждения кода.
          </p>
          <form className="registration-form" onSubmit={handleRequestCode}>
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
              {submitting ? "Отправляем код…" : "Получить код"}
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
        </>
      ) : (
        <>
          <p className="registration-card-copy registration-card-copy-emphasis">
            Введите код из письма
          </p>
          <form className="registration-form" onSubmit={handleVerifyCode}>
            <label className="registration-field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                readOnly
                autoComplete="email"
              />
            </label>

            <label className="registration-field">
              <span>Код</span>
              <input
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="123456"
                autoComplete="one-time-code"
                inputMode="numeric"
                required
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
              {submitting ? "Подтверждаем…" : "Подтвердить"}
            </button>

            <button
              type="button"
              className="registration-secondary-action"
              onClick={goBackToEmail}
            >
              Изменить email
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
        </>
      )}
    </section>
  );
}

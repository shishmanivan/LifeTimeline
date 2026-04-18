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
      setErrorMessage("Укажите email, который использовался при регистрации.");
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
        setErrorMessage("Профиль для этого email не найден.");
      } else if (message.includes("400")) {
        setErrorMessage("Проверьте email и попробуйте ещё раз.");
      } else {
        setErrorMessage("Не удалось запросить recovery code. Попробуйте ещё раз.");
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
      setErrorMessage("Укажите email и recovery code.");
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
        setErrorMessage("Профиль для этого email не найден.");
      } else if (message.includes("expired-code")) {
        setErrorMessage("Recovery code истёк. Запросите новый код.");
      } else if (message.includes("invalid-code")) {
        setErrorMessage("Recovery code неверный.");
      } else if (message.includes("400")) {
        setErrorMessage("Проверьте email и recovery code.");
      } else {
        setErrorMessage("Не удалось подтвердить recovery code. Попробуйте ещё раз.");
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
      <h2 className="registration-card-title">Войти</h2>

      {loginStep === "enter_email" ? (
        <>
          <p className="registration-card-copy">
            Укажите email — мы отправим одноразовый код для входа в этот браузер.
          </p>
          <p className="registration-card-copy">
            Не можете войти? Этим же способом можно восстановить доступ к уже
            созданному профилю.
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

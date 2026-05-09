type PartOfThisReactionIconProps = {
  active: boolean;
};

export function PartOfThisReactionIcon({ active }: PartOfThisReactionIconProps) {
  return (
    <svg
      className={`part-of-this-icon ${active ? "part-of-this-icon--active" : ""}`}
      width="28"
      height="28"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle className="part-of-this-icon__center" cx="32" cy="32" r="4.6" />

      <g className="part-of-this-icon__satellite part-of-this-icon__satellite--top">
        <circle className="part-of-this-icon__dot" cx="32" cy="17" r="3.1" />
      </g>

      <g className="part-of-this-icon__satellite part-of-this-icon__satellite--upper-left">
        <circle className="part-of-this-icon__dot" cx="21.5" cy="26" r="3.1" />
      </g>

      <g className="part-of-this-icon__satellite part-of-this-icon__satellite--upper-right">
        <circle className="part-of-this-icon__dot" cx="42.5" cy="26" r="3.1" />
      </g>

      <g className="part-of-this-icon__satellite part-of-this-icon__satellite--lower-left">
        <circle className="part-of-this-icon__dot" cx="25" cy="43" r="3.1" />
      </g>

      <g className="part-of-this-icon__satellite part-of-this-icon__satellite--lower-right">
        <circle className="part-of-this-icon__dot" cx="39" cy="43" r="3.1" />
      </g>
    </svg>
  );
}

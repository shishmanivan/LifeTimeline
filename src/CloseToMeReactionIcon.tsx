type CloseToMeReactionIconProps = {
  active: boolean;
};

export function CloseToMeReactionIcon({ active }: CloseToMeReactionIconProps) {
  return (
    <svg
      className={`close-to-me-icon ${active ? "close-to-me-icon--active" : ""}`}
      width="28"
      height="18"
      viewBox="0 0 240 140"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g id="leftPetal" className="close-to-me-icon__left">
        <path
          className="close-to-me-icon__outline"
          d="M26 22
             C18 58, 20 95, 48 118
             C63 131, 82 136, 103 134
             C104 117, 103 97, 98 78
             C92 55, 77 36, 54 24
             C44 19, 35 18, 26 22 Z"
        />
        <path
          className="close-to-me-icon__accent"
          d="M96 134
             C96 122, 97 111, 99 100
             C103 105, 105 114, 105 128
             C102 131, 99 133, 96 134 Z"
        />
      </g>

      <g id="rightPetal" className="close-to-me-icon__right">
        <path
          className="close-to-me-icon__outline"
          d="M214 22
             C222 58, 220 95, 192 118
             C177 131, 158 136, 137 134
             C136 117, 137 97, 142 78
             C148 55, 163 36, 186 24
             C196 19, 205 18, 214 22 Z"
        />
        <path
          className="close-to-me-icon__accent"
          d="M144 134
             C144 122, 143 111, 141 100
             C137 105, 135 114, 135 128
             C138 131, 141 133, 144 134 Z"
        />
      </g>

      <path
        id="overlap"
        className="close-to-me-icon__overlap"
        d="M120 100
           C115 107, 113 115, 114 127
           C116 131, 118 134, 120 136
           C122 134, 124 131, 126 127
           C127 115, 125 107, 120 100 Z"
      />
    </svg>
  );
}

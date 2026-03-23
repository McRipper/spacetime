import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			"@typescript-eslint/naming-convention": "warn",
			"@typescript-eslint/no-explicit-any": "off",
			curly: "warn",
			eqeqeq: "warn",
			"no-throw-literal": "warn",
		},
	},
	{
		ignores: ["out/", "**/*.d.ts"],
	}
);

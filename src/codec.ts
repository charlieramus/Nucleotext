import {
	BASE_OF_DIGIT,
	decodeFromCodes,
	HuffmanMapping,
	textToDigits,
	validateMapping,
} from "./huffman";
import { ConstraintConfig, transcode, untranscode } from "./transcode";

export interface EncodeResult {
	/** Raw, unconstrained stage-4 sequence (digit i -> BASES[i]). */
	raw: string;
	/** Constrained sequence with homopolymer + GC constraints applied. */
	constrained: string;
}

/**
 * Full encode pipeline: text -> Huffman digits -> (raw bases, constrained bases).
 * Throws `UnknownCharacterError` if the text contains characters not in the map.
 */
export function encode(
	text: string,
	mapping: HuffmanMapping,
	cfg: ConstraintConfig
): EncodeResult {
	const digits = textToDigits(text, mapping);
	const raw = digits.map((d) => BASE_OF_DIGIT[d]).join("");
	const constrained = transcode(digits, cfg);
	return { raw, constrained };
}

/**
 * Full decode pipeline: constrained bases -> digits -> raw code stream -> text.
 * Validates the mapping first; throws `DecodeError` for a missing/corrupt
 * mapping or an undecodable sequence rather than returning silent garbage.
 */
export function decode(
	constrained: string,
	mapping: HuffmanMapping | null | undefined,
	cfg: ConstraintConfig
): string {
	validateMapping(mapping);
	const digits = untranscode(constrained, cfg);
	const codeStr = digits.map((d) => BASE_OF_DIGIT[d]).join("");
	return decodeFromCodes(codeStr, mapping);
}

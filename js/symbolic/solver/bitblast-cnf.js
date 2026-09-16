import {
  EXPR_KIND, SORT_KIND, BV_UNARY_OP, BV_BINARY_OP, BV_COMPARE_OP, BOOL_CONNECTIVE_OP, CAST_OP,
} from '../expr/kinds.js';
import { CnfBuilderBase, LimitError } from './bitblast-cnf-base.js';

export class CnfBuilder extends CnfBuilderBase {
  compile(expr) {
    if (this.expressionMemo.has(expr)) return this.expressionMemo.get(expr);
    let compiled;
    switch (expr.kind) {
      case EXPR_KIND.CONST:
        compiled = expr.sort.kind === SORT_KIND.BOOL
          ? { kind: SORT_KIND.BOOL, literal: this.constant(expr.value) }
          : { kind: SORT_KIND.BV, bits: this.constantBits(expr.sort.width, expr.value) };
        break;
      case EXPR_KIND.FRESH_SYMBOL: {
        const key = String(expr.symbolId || expr.name);
        if (!this.symbolBits.has(key)) {
          this.symbolBits.set(key, expr.sort.kind === SORT_KIND.BOOL
            ? { kind: SORT_KIND.BOOL, literal: this.newVariable() }
            : { kind: SORT_KIND.BV, bits: Array.from({ length: expr.sort.width }, () => this.newVariable()) });
        }
        compiled = this.symbolBits.get(key);
        break;
      }
      case EXPR_KIND.UNARY: {
        const arg = this.compile(expr.arg).bits;
        compiled = { kind: SORT_KIND.BV, bits: expr.op === BV_UNARY_OP.NOT ? arg.map((literal) => -literal) : this.negateBits(arg) };
        break;
      }
      case EXPR_KIND.BINARY: {
        const left = this.compile(expr.left).bits;
        const right = this.compile(expr.right).bits;
        let bits;
        switch (expr.op) {
          case BV_BINARY_OP.ADD: bits = this.addBits(left, right); break;
          case BV_BINARY_OP.SUB: bits = this.subtractBits(left, right); break;
          case BV_BINARY_OP.MUL: bits = this.multiplyBits(left, right); break;
          case BV_BINARY_OP.UDIV: bits = this.unsignedDivideRemainder(left, right).quotient; break;
          case BV_BINARY_OP.UREM: bits = this.unsignedDivideRemainder(left, right).remainder; break;
          case BV_BINARY_OP.SDIV: bits = this.signedDivideRemainder(left, right).quotient; break;
          case BV_BINARY_OP.SREM: bits = this.signedDivideRemainder(left, right).remainder; break;
          case BV_BINARY_OP.AND: bits = left.map((literal, bit) => this.and(literal, right[bit])); break;
          case BV_BINARY_OP.OR: bits = left.map((literal, bit) => this.or(literal, right[bit])); break;
          case BV_BINARY_OP.XOR: bits = left.map((literal, bit) => this.xor(literal, right[bit])); break;
          case BV_BINARY_OP.SHL:
          case BV_BINARY_OP.LSHR:
          case BV_BINARY_OP.ASHR: bits = this.shiftBits(left, right, expr.op); break;
          default: throw new LimitError(`unsupported-binary-op:${expr.op}`);
        }
        compiled = { kind: SORT_KIND.BV, bits };
        break;
      }
      case EXPR_KIND.COMPARE: {
        const left = this.compile(expr.left).bits;
        const right = this.compile(expr.right).bits;
        const eq = () => this.equalBits(left, right);
        const ult = () => this.unsignedLess(left, right);
        const slt = () => this.signedLess(left, right);
        let literal;
        switch (expr.op) {
          case BV_COMPARE_OP.EQ: literal = eq(); break;
          case BV_COMPARE_OP.NE: literal = -eq(); break;
          case BV_COMPARE_OP.ULT: literal = ult(); break;
          case BV_COMPARE_OP.ULE: literal = -this.unsignedLess(right, left); break;
          case BV_COMPARE_OP.UGT: literal = this.unsignedLess(right, left); break;
          case BV_COMPARE_OP.UGE: literal = -ult(); break;
          case BV_COMPARE_OP.SLT: literal = slt(); break;
          case BV_COMPARE_OP.SLE: literal = -this.signedLess(right, left); break;
          case BV_COMPARE_OP.SGT: literal = this.signedLess(right, left); break;
          case BV_COMPARE_OP.SGE: literal = -slt(); break;
          default: throw new LimitError(`unsupported-compare-op:${expr.op}`);
        }
        compiled = { kind: SORT_KIND.BOOL, literal };
        break;
      }
      case EXPR_KIND.CONNECTIVE: {
        const args = expr.args.map((arg) => this.compile(arg).literal);
        let literal;
        switch (expr.op) {
          case BOOL_CONNECTIVE_OP.AND: literal = this.reduceAnd(args); break;
          case BOOL_CONNECTIVE_OP.OR: literal = this.reduceOr(args); break;
          case BOOL_CONNECTIVE_OP.NOT: literal = -args[0]; break;
          case BOOL_CONNECTIVE_OP.XOR: literal = args.reduce((acc, arg) => this.xor(acc, arg), this.constant(false)); break;
          case BOOL_CONNECTIVE_OP.IMPLIES: literal = this.or(-args[0], args[1]); break;
          case BOOL_CONNECTIVE_OP.EQ: literal = -this.xor(args[0], args[1]); break;
          case BOOL_CONNECTIVE_OP.NE: literal = this.xor(args[0], args[1]); break;
          default: throw new LimitError(`unsupported-connective-op:${expr.op}`);
        }
        compiled = { kind: SORT_KIND.BOOL, literal };
        break;
      }
      case EXPR_KIND.ITE: {
        const condition = this.compile(expr.cond).literal;
        const thenValue = this.compile(expr.thenExpr);
        const elseValue = this.compile(expr.elseExpr);
        compiled = thenValue.kind === SORT_KIND.BOOL
          ? { kind: SORT_KIND.BOOL, literal: this.ite(condition, thenValue.literal, elseValue.literal) }
          : { kind: SORT_KIND.BV, bits: this.muxBits(condition, thenValue.bits, elseValue.bits) };
        break;
      }
      case EXPR_KIND.EXTRACT:
        compiled = { kind: SORT_KIND.BV, bits: this.compile(expr.arg).bits.slice(expr.low, expr.high + 1) };
        break;
      case EXPR_KIND.CONCAT: {
        const left = this.compile(expr.left).bits;
        const right = this.compile(expr.right).bits;
        compiled = { kind: SORT_KIND.BV, bits: [...right, ...left] };
        break;
      }
      case EXPR_KIND.CAST: {
        const arg = this.compile(expr.arg).bits;
        if (expr.op === CAST_OP.TRUNC) compiled = { kind: SORT_KIND.BV, bits: arg.slice(0, expr.targetWidth) };
        else {
          const fill = expr.op === CAST_OP.SEXT ? arg[arg.length - 1] : this.constant(false);
          compiled = { kind: SORT_KIND.BV, bits: [...arg, ...Array.from({ length: expr.targetWidth - arg.length }, () => fill)] };
        }
        break;
      }
      default:
        throw new LimitError(`unsupported-expression-kind:${expr.kind}`);
    }
    this.expressionMemo.set(expr, compiled);
    return compiled;
  }
}


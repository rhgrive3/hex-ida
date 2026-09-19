/* Auto-injected type definitions by preprocessor */
typedef unsigned char uint8_t;
typedef unsigned short uint16_t;
typedef unsigned int uint32_t;
typedef unsigned long long uint64_t;
typedef signed char int8_t;
typedef short int16_t;
typedef int int32_t;
typedef long long int64_t;
typedef unsigned long size_t;
typedef long ssize_t;
typedef unsigned long uintptr_t;
typedef long intptr_t;
typedef unsigned long ptrdiff_t;
typedef long long intmax_t;
typedef unsigned long long uintmax_t;

/* raw-function-text: address=2368 name=_start state=PASS completeness=complete */
void start(void)
{
 unknown_call(global_13FD8);
 unknown_call(global_13FD8);
}

/* raw-function-text: address=2420 name=__dollar_x state=PASS completeness=complete */
uint64 __dollar_x(void)
{
 x0_1 = *(uint64 *)0x13FD0;
 __asm("cbz x0, #0x984");
 return sub_8E0(x0_1);
 return x0;
}

/* raw-function-text: address=2448 name=__dollar_x state=PARTIAL completeness=partial */
uint64 __dollar_x(void)
 loc_9A0:
{
 /* cmp x1, x0 — 次の分岐のための比較 */
 __asm("b_eq #0x9bc");
 x1 = *(uint64 *)0x13FC0;
 __asm("cbz x1, #0x9bc");
 __asm("br x16");
 goto loc_9A0;
 return x0;
}

/* raw-function-text: address=2496 name=register_tm_clones state=PARTIAL completeness=partial */
uint64 register_tm_clones(void)
{
 __asm("cbz x1, #0x9f8");
 x2 = *(uint64 *)0x13FE0;
 __asm("cbz x2, #0x9f8");
 __asm("br x16");
 return x0;
}

/* raw-function-text: address=2560 name=__do_global_dtors_aux state=PARTIAL completeness=partial */
uint32 do_global_dtors_aux(void)
{
 // … ほかに 2 個の置き場（退避用など）があります

 x19 = 0x14000;
 __asm("cbnz w0, #0xa3c");
 x0_1 = *(uint64 *)0x13FC8;
 __asm("cbz x0, #0xa30");
 x0_2 = sub_8D0("H@");
 x0_3 = __dollar_x();
 *(uint8 *)(x19 + 0x50) = 1;
 return x0;
}

/* raw-function-text: address=2640 name=frame_dummy state=PARTIAL completeness=partial */
void frame_dummy(void)
 loc_A54:
{
 return register_tm_clones();
}
 goto loc_A54;

/* raw-function-text: address=2644 name=sequential_ops state=PASS completeness=complete */
void sequential_ops(void)
{
 local_m4 = a1;
 local_m8 = a2;
 local_mC = a3;
 local_m10 = (uint32_t)a1 + (uint32_t)a2;
 local_m14 = ((uint32_t)((uint32_t)a1 + (uint32_t)a2) << 1);
 local_m18 = var_110;
 return;
}

/* raw-function-text: address=2716 name=single_if state=PASS completeness=complete */
void single_if(void)
{
 local_m4 = a1;
 if ((int32_t)a1 > 0) {
 local_m4 = ((uint32_t)(uint32_t)a1 << 1);
 }
 return;
}

/* raw-function-text: address=2768 name=if_else state=PASS completeness=complete */
void if_else(void)
{
 local_m8 = a1;
 if ((int32_t)a1 <= 0) {
 local_m4 = 0;
 } else {
 local_m4 = 1;
 }
 return;
}

/* raw-function-text: address=2824 name=nested_if_2 state=PASS completeness=complete */
void nested_if_2(void)
{
 local_m8 = a1;
 local_mC = a2;
 if ((int32_t)a1 <= 0) {
 local_m4 = 0;
 } else {
 if ((int32_t)a2 <= 0) {
 local_m4 = (uint32_t)a1;
 } else {
 local_m4 = (uint32_t)a1 + (uint32_t)a2;
 }
 }
 return;
}

/* raw-function-text: address=2920 name=nested_if_deep state=PASS completeness=complete */
void nested_if_deep(void)
{
 local_m8 = a1;
 local_mC = a2;
 local_m10 = a3;
 local_m14 = a4;
 local_m18 = a5;
 if ((int32_t)a1 <= 0) {
 local_m4 = 0;
 } else {
 if ((int32_t)a2 <= 0) {
 local_m4 = 1;
 } else {
 if ((int32_t)a3 <= 0) {
 local_m4 = 2;
 } else {
 if ((int32_t)a4 <= 0) {
 local_m4 = 3;
 } else {
 if ((int32_t)a5 <= 0) {
 local_m4 = 4;
 } else {
 local_m4 = 5;
 }
 }
 }
 }
 }
 return;
}

/* raw-function-text: address=3104 name=if_elseif_chain state=PASS completeness=complete */
void if_elseif_chain(void)
{
 local_m8 = a1;
 if (a1 != 0) {
 if ((uint32_t)a1 != 1) {
 if ((uint32_t)a1 != 2) {
 local_m4 = 0xFFFFFFFF;
 } else {
 local_m4 = 30;
 }
 } else {
 local_m4 = 20;
 }
 } else {
 local_m4 = 10;
 }
 return;
}

/* raw-function-text: address=3216 name=if_elseif_long state=PASS completeness=complete */
void if_elseif_long(void)
{
 local_m8 = a1;
 if (a1 != 0) {
 if ((uint32_t)a1 != 1) {
 if ((uint32_t)a1 != 2) {
 if ((uint32_t)a1 != 3) {
 if ((uint32_t)a1 != 4) {
 local_m4 = 0xFFFFFFFF;
 } else {
 local_m4 = 0x1F4;
 }
 } else {
 local_m4 = 0x190;
 }
 } else {
 local_m4 = 0x12C;
 }
 } else {
 local_m4 = 0xC8;
 }
 } else {
 local_m4 = 0x64;
 }
 return;
}

/* raw-function-text: address=3756 name=switch_default state=PASS completeness=complete */
void switch_default(void)
{
 local_m8 = a1;
 local_mC = (uint32_t)a1;
 if ((uint32_t)var_4 == 1) {
 local_m4 = 0x64;
 } else {
 if ((uint32_t)a1 == 2) {
 local_m4 = 0xC8;
 } else {
 if ((uint32_t)a1 == 3) {
 local_m4 = 0x12C;
 } else {
 local_m4 = 0;
 }
 }
 }
 return;
}

/* raw-function-text: address=3872 name=switch_fallthrough state=PASS completeness=complete */
void switch_fallthrough(void)
{
 local_m4 = a1;
 local_m8 = 0;
 local_mC = (uint32_t)a1;
 if ((uint32_t)var_4 == 1) {
 local_m8 += (uint32_t)a1;
 } else {
 if ((uint32_t)a1 == 2) {
 local_m8 += ((uint32_t)(uint32_t)a1 << 1);
 goto loc_F88;
 } else {
 if ((uint32_t)a1 != 3) {
 local_m8 = 0xFFFFFFFF;
 } else {
 local_m8 = ((uint32_t)(uint32_t)a1 << 2);
 goto loc_F74;
 }
 }
 }
 return;
}

/* raw-function-text: address=4020 name=loop_for_fixed state=PASS completeness=complete */
void loop_for_fixed(void)
{
 local_m4 = a1;
 local_m8 = 0;
 local_mC = 0;
 while ((int32_t)var_4 < (int32_t)var_C) {
 local_m8 += local_mC;
 local_mC++;
 continue;
 }
 return;
}

/* raw-function-text: address=4108 name=loop_while state=PASS completeness=complete */
void loop_while(void)
{
 local_m4 = a1;
 local_m8 = 0;
 while (!(var_C == 0)) {
 local_m4 = (int32_t)local_m4 / 10;
 local_m8++;
 continue;
 }
 if ((int32_t)var_8 <= 0) {
 local_mC = 1;
 } else {
 local_mC = local_m8;
 }
 return;
}

/* raw-function-text: address=4220 name=loop_dowhile state=PASS completeness=complete */
void loop_dowhile(void)
{
 local_m4 = a1;
 local_m8 = 0;
 local_m4 = (int32_t)local_m4 / 10;
 local_m8++;
 local_m4 = (int32_t)local_m4 / 10;
 local_m8++;
 if (var_C != 0) {
 goto loc_108C;
 }
 return;
}

/* raw-function-text: address=4292 name=loop_nested state=PASS completeness=complete */
void loop_nested(void)
{
 local_m4 = a1;
 local_m8 = a2;
 local_mC = 0;
 local_m10 = 0;
 while ((int32_t)var_10 < (int32_t)var_1C) {
 local_m14 = 0;
 if ((int32_t)var_C < (int32_t)var_18) {
 local_mC++;
 local_m14++;
 goto loc_10F8;
 }
 local_m10++;
 continue;
 }
 return;
}

/* raw-function-text: address=4428 name=loop_break state=PASS completeness=complete */
void loop_break(void)
{
 local_m8 = a1;
 local_m20 = global_2B04;
 local_m10 = global_2B14;
 local_m24 = 5;
 local_m28 = 0;
 if ((int32_t)var_8 >= (int32_t)var_C) {
 local_m4 = 0xFFFFFFFF;
 } else {
 if ((uint32_t)((sp - 48) + 16)[sext(var_8)] != (uint32_t)var_28) {
 local_m28++;
 goto loc_117C;
 } else {
 local_m4 = local_m28;
 }
 }
 return;
}

/* raw-function-text: address=4580 name=loop_continue state=PASS completeness=complete */
void loop_continue(void)
{
 local_m4 = a1;
 local_m8 = 0;
 local_mC = 1;
 while ((int32_t)var_4 <= (int32_t)var_C) {
 if (v44 != 0) {
 local_m8 += local_mC;
 } else {
 }
 local_mC++;
 continue;
 }
 return;
}

/* raw-function-text: address=4704 name=goto_forward state=PASS completeness=complete */
void goto_forward(void)
{
 local_m4 = a1;
 if ((int32_t)a1 <= 0) {
 local_m8 = (uint32_t)a1;
 } else {
 local_m8 = (uint32_t)a1 * (uint32_t)a1;
 }
 local_m8 = ((uint32_t)local_m8 << 1);
 return;
}

/* raw-function-text: address=4788 name=goto_backward state=PASS completeness=complete */
void goto_backward(void)
{
 local_m8 = a1;
 if ((int32_t)a1 > 0) {
 local_mC = 1;
 local_m10 = 1;
 while ((int32_t)var_0 <= (int32_t)var_8) {
 local_mC *= local_m10;
 local_m10++;
 continue;
 }
 local_m4 = local_mC;
 } else {
 local_m4 = 1;
 }
 return;
}

/* raw-function-text: address=4920 name=ternary_op state=PASS completeness=complete */
void ternary_op(void)
{
 local_m4 = a1;
 local_m8 = a2;
 if ((int32_t)a1 <= (int32_t)a2) {
 local_mC = (uint32_t)a2;
 } else {
 local_mC = (uint32_t)a1;
 }
 return;
}

/* raw-function-text: address=4988 name=test_control_flow_l1 state=PASS completeness=complete */
void test_control_flow_l1(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 unknown_call("=== 测试基础控制流特征 ===\\n");
 local_m24 = 5;
 local_m44 = 7;
 local_m1C = 3;
 sequential_ops(/* arguments unknown */);
 unknown_call("CF-L1-01 (sequential_ops): %d\\n");
 local_m20 = 10;
 single_if(/* arguments unknown */);
 local_m68 = 0x2BA0;
 unknown_call(0x2BA0);
 local_m54 = 0xFFFFFFFB;
 single_if(/* arguments unknown */);
 unknown_call(var_m68);
 if_else(/* arguments unknown */);
 local_m60 = 0x2BBA;
 unknown_call(0x2BBA);
 local_m34 = 0xFFFFFFFD;
 if_else(/* arguments unknown */);
 unknown_call(var_m60);
 nested_if_2(/* arguments unknown */);
 local_m50 = 0x2BD2;
 unknown_call(0x2BD2);
 nested_if_2(/* arguments unknown */);
 unknown_call(var_m50);
 nested_if_2(/* arguments unknown */);
 unknown_call(var_m50);
 local_m48 = 1;
 nested_if_deep(/* arguments unknown */);
 unknown_call("CF-L1-05 (nested_if_deep): %d\\n");
 if_elseif_chain(/* arguments unknown */);
 unknown_call("CF-L1-06 (if_elseif_chain): %d\\n");
 if_elseif_long(/* arguments unknown */);
 unknown_call("CF-L1-07 (if_elseif_long): %d\\n");
 switch_small(/* arguments unknown */);
 unknown_call("CF-L1-08 (switch_small): %d\\n");
 switch_large(/* arguments unknown */);
 unknown_call("CF-L1-09 (switch_large): %d\\n");
 switch_default(/* arguments unknown */);
 unknown_call("CF-L1-10 (switch_default): %d\\n");
 switch_fallthrough(/* arguments unknown */);
 unknown_call("CF-L1-11 (switch_fallthrough): %d\\n");
 loop_for_fixed(/* arguments unknown */);
 unknown_call("CF-L1-12 (loop_for_fixed): %d\\n");
 loop_while(/* arguments unknown */);
 unknown_call("CF-L1-13 (loop_while): %d\\n");
 loop_dowhile(/* arguments unknown */);
 unknown_call("CF-L1-14 (loop_dowhile): %d\\n");
 loop_nested(/* arguments unknown */);
 unknown_call("CF-L1-15 (loop_nested): %d\\n");
 loop_break(/* arguments unknown */);
 local_m40 = 0x2D3B;
 unknown_call(0x2D3B);
 loop_break(/* arguments unknown */);
 unknown_call(var_m40);
 loop_continue(/* arguments unknown */);
 unknown_call("CF-L1-17 (loop_continue): %d\\n");
 goto_forward(/* arguments unknown */);
 local_m30 = 0x2D74;
 unknown_call(0x2D74);
 goto_forward(/* arguments unknown */);
 unknown_call(var_m30);
 goto_backward(/* arguments unknown */);
 unknown_call("CF-L1-19 (goto_backward): %d\\n");
 ternary_op(/* arguments unknown */);
 local_m18 = 0x2DAF;
 unknown_call(0x2DAF);
 ternary_op(/* arguments unknown */);
 unknown_call(var_m18);
 return;
}

/* raw-function-text: address=5744 name=loop_multi_exit state=PASS completeness=complete */
void loop_multi_exit(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m18 = a1;
 unknown_call((sp - 80) + 8);
 local_m4C = 0;
 if ((int32_t)var_m4C >= 3) {
 local_m14 = 0xFFFFFFFF;
 } else {
 local_m50 = 0;
 if ((int32_t)var_m50 >= 4) {
 local_m4C++;
 goto loc_169C;
 } else {
 if ((uint32_t)(((sp - 80) + 8) + ((sext(var_m4C)) << 4))[sext(var_m50)] != (uint32_t)var_m18) {
 local_m50++;
 goto loc_16B4;
 } else {
 local_m14 = local_m4C * 10 + local_m50;
 }
 }
 }
 return;
}

/* raw-function-text: address=6060 name=multi_return state=PASS completeness=complete */
void multi_return(void)
{
 local_m8 = a1;
 if ((int32_t)a1 >= 0) {
 local_mC = ((uint32_t)(uint32_t)a1 << 1);
 if ((int32_t)var_4 <= 0x64) {
 if (v165 != 0) {
 local_m4 = (uint32_t)a1 + 1;
 } else {
 local_m4 = local_mC;
 }
 } else {
 local_m4 = 0xFFFFFFFE;
 }
 } else {
 local_m4 = 0xFFFFFFFF;
 }
 return;
}

/* raw-function-text: address=6204 name=conditional_return state=PASS completeness=complete */
void conditional_return(void)
{
 local_m4 = a1;
 if ((int32_t)a1 <= 0) {
 if ((int32_t)a1 >= 0) {
 local_mC = 0;
 } else {
 local_mC = var_65;
 }
 local_m8 = local_mC;
 } else {
 local_m8 = ((uint32_t)(uint32_t)a1 << 1);
 }
 return;
}

/* raw-function-text: address=6316 name=duffs_device state=PASS completeness=complete */
uint32 duffs_device(uint32 a1, int64 a2, int64 a3)
{
 uint64 var_8, var_18, var_20;
 uint32 var_10, var_14, var_2C;

 var_20 = a1;
 var_18 = a2;
 var_14 = (uint32)a3;
 __asm("b_gt #0x18d8");
 __asm("b #0x18cc");
 var_2C = 0xFFFFFFFF;
 __asm("b #0x1a74");
 var_10 = (uint32)((uint32)((uint32)var_14 + 7) / 8);
 x8_1 = var_14;
 x8_2 = (uint32)(x8_1 - (uint32)((uint32)(x8_1 / 8) * 8));
 var_8 = x8_2;
 __asm("b_hi #0x1a68");
 x8_2 = var_8;
 __asm("br x8");
 __asm("b #0x192c");
 var_18 = x8_3 + 4;
 var_20 = var_20 + 4;
 *(uint32 *)(x9) = (uint32)*(uint32 *)(var_18);
 __asm("b #0x1950");
 var_18 = x8_4 + 4;
 var_20 = var_20 + 4;
 *(uint32 *)(x9) = (uint32)*(uint32 *)(var_18);
 __asm("b #0x1974");
 var_18 = x8_5 + 4;
 var_20 = var_20 + 4;
 *(uint32 *)(x9) = (uint32)*(uint32 *)(var_18);
 __asm("b #0x1998");
 var_18 = x8_6 + 4;
 var_20 = var_20 + 4;
 *(uint32 *)(x9) = (uint32)*(uint32 *)(var_18);
 __asm("b #0x19bc");
 var_18 = x8_7 + 4;
 var_20 = var_20 + 4;
 *(uint32 *)(x9) = (uint32)*(uint32 *)(var_18);
 __asm("b #0x19e0");
 var_18 = x8_8 + 4;
 var_20 = var_20 + 4;
 *(uint32 *)(x9) = (uint32)*(uint32 *)(var_18);
 __asm("b #0x1a04");
 var_18 = x8_9 + 4;
 var_20 = var_20 + 4;
 *(uint32 *)(x9) = (uint32)*(uint32 *)(var_18);
 __asm("b #0x1a28");
 var_18 = x8_10 + 4;
 var_20 = var_20 + 4;
 *(uint32 *)(x9) = (uint32)*(uint32 *)(var_18);
 __asm("b #0x1a4c");
 var_10 = (uint32)((uint32)var_10 - 1);
 __asm("b_gt #0x192c");
 __asm("b #0x1a64");
 __asm("b #0x1a68");
 var_2C = (uint32)var_14;
 __asm("b #0x1a74");
 return x0;
}

/* raw-function-text: address=6784 name=loop_complex_cond state=PASS completeness=complete */
void loop_complex_cond(void)
{
 local_m4 = a1;
 local_m8 = 0;
 local_mC = (uint32_t)a1;
 local_m10 = 0;
 local_m14 = 0;
 local_m14 = 0;
 if ((int32_t)var_18 < (int32_t)var_14) {
 local_m14 = 0;
 if ((int32_t)var_10 < 10) {
 local_m14 = (int32_t)local_mC > 0 ? 1 : 0;
 }
 }
 if (!(bit_extract(var_C, 0, 1) == 0)) {
 local_m8 += 2;
 local_mC = var_240;
 local_m10++;
 goto loc_1A9C;
 }
 return;
}

/* raw-function-text: address=6964 name=loop_modify_var state=PASS completeness=complete */
void loop_modify_var(void)
{
 local_m4 = a1;
 local_m8 = 0;
 local_mC = 0;
 while ((int32_t)var_4 < (int32_t)var_C) {
 local_m8 += local_mC;
 if ((int32_t)var_4 > 5) {
 local_mC += 2;
 }
 local_mC++;
 continue;
 }
 return;
}

/* raw-function-text: address=7084 name=loop_external_state state=PASS completeness=complete */
void loop_external_state(void)
{
 local_m8 = a1;
 local_mC = 0;
 if (!(memory_unknown != 0)) {
 local_mC++;
 if ((int32_t)var_4 <= 0x64) {
 goto loc_1BBC;
 } else {
 }
 }
 return;
}

/* raw-function-text: address=7164 name=recursion_factorial state=PASS completeness=complete */
void recursion_factorial(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m18 = a1;
 if ((int32_t)var_8 > 1) {
 local_m1C = local_m18;
 recursion_factorial(/* arguments unknown */);
 local_m14 = local_m1C * (uint32_t)call_189;
 } else {
 local_m14 = 1;
 }
 return;
}

/* raw-function-text: address=7260 name=tail_recursion state=PASS completeness=complete */
void tail_recursion(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m18 = a1;
 local_m1C = a2;
 if ((int32_t)var_8 > 1) {
 tail_recursion(/* arguments unknown */);
 local_m14 = call_155;
 } else {
 local_m14 = local_m1C;
 }
 return;
}

/* raw-function-text: address=7356 name=indirect_recursion_a state=PASS completeness=complete */
void indirect_recursion_a(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m18 = a1;
 local_m1C = a2;
 if ((int32_t)var_p4 > 0) {
 if (v39 != 0) {
 indirect_recursion_b(/* arguments unknown */);
 local_m14 = call_342;
 } else {
 indirect_recursion_b(/* arguments unknown */);
 local_m14 = call_266;
 }
 } else {
 local_m14 = local_m18;
 }
 return;
}

/* raw-function-text: address=7516 name=indirect_recursion_b state=PASS completeness=complete */
void indirect_recursion_b(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m18 = a1;
 local_m1C = a2;
 if ((int32_t)var_p4 > 0) {
 indirect_recursion_a(/* arguments unknown */);
 local_m14 = call_147;
 } else {
 local_m14 = local_m18;
 }
 return;
}

/* raw-function-text: address=7608 name=call_func_ptr state=PASS completeness=complete */
void call_func_ptr(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m18 = a1;
 local_m1C = a2;
 unknown_call(var_4);
 return;
}

/* raw-function-text: address=7652 name=call_func_ptr_array state=PASS completeness=complete */
void call_func_ptr_array(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m18 = a1;
 local_m1C = a2;
 local_m40 = global_13D30;
 local_m30 = global_13D40;
 if (__arm64_condition_unknown(/* NZCV */)) {
 local_m14 = 0xFFFFFFFF;
 } else {
 if ((int32_t)var_m18 < 3) {
 unknown_call(var_m1C);
 local_m14 = call_163;
 } else {
 goto loc_1E2C;
 }
 }
 return;
}

/* raw-function-text: address=7780 name=double_value state=PASS completeness=complete */
void double_value(void)
{
 local_m4 = a1;
 return;
}

/* raw-function-text: address=7804 name=triple_value state=PASS completeness=complete */
void triple_value(void)
{
 local_m4 = a1;
 return;
}

/* raw-function-text: address=7832 name=call_virtual_func state=PASS completeness=complete */
void call_virtual_func(void)
{
 local_m8 = a1;
 local_mC = a2;
 return;
}

/* raw-function-text: address=7860 name=process_with_callback state=PASS completeness=complete */
void process_with_callback(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m18 = a1;
 local_m1C = a2;
 local_m28 = a3;
 local_m2C = 0;
 local_m30 = 0;
 while ((int32_t)memory_unknown < (int32_t)memory_unknown) {
 unknown_call(memory_unknown[sext(memory_unknown)]);
 memory_unknown = memory_unknown + (uint32_t)call_129;
 memory_unknown = memory_unknown + 1;
 continue;
 }
 return;
}

/* raw-function-text: address=7984 name=test_control_flow_l2 state=PASS completeness=complete */
void test_control_flow_l2(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 unknown_call("=== 测试高级控制流特征 ===\\n");
 loop_multi_exit(/* arguments unknown */);
 unknown_call("CF-L2-01 (loop_multi_exit): %d\\n");
 local_m9C = 0;
 local_m14 = 0;
 infinite_loop(/* arguments unknown */);
 unknown_call("CF-L2-02 (infinite_loop): %d\\n");
 local_mB4 = 0xFFFFFFFB;
 multi_return(/* arguments unknown */);
 local_mC0 = 0x2E2D;
 unknown_call(0x2E2D);
 multi_return(/* arguments unknown */);
 unknown_call(var_mC0);
 local_mA4 = 3;
 multi_return(/* arguments unknown */);
 unknown_call(var_mC0);
 local_m8C = 5;
 conditional_return(/* arguments unknown */);
 local_mB0 = 0x2E4A;
 unknown_call(0x2E4A);
 conditional_return(/* arguments unknown */);
 unknown_call(var_mB0);
 local_m40 = global_3120;
 local_m30 = global_3130;
 local_m60 = var_506;
 local_m50 = var_506;
 duffs_device(/* arguments unknown */);
 unknown_call("CF-L2-05 (duffs_device): %d\\n");
 local_mA0 = 10;
 loop_complex_cond(/* arguments unknown */);
 unknown_call("CF-L2-06 (loop_complex_cond): %d\\n");
 loop_modify_var(/* arguments unknown */);
 unknown_call("CF-L2-07 (loop_modify_var): %d\\n");
 local_m64 = 0;
 loop_external_state(/* arguments unknown */);
 unknown_call("CF-L2-08 (loop_external_state): %d\\n");
 recursion_factorial(/* arguments unknown */);
 unknown_call("CF-L2-09 (recursion_factorial): %d\\n");
 tail_recursion(/* arguments unknown */);
 unknown_call("CF-L2-10 (tail_recursion): %d\\n");
 indirect_recursion_a(/* arguments unknown */);
 unknown_call("CF-L2-11 (indirect_recursion): %d\\n");
 local_m88 = 0x1E64;
 call_func_ptr(/* arguments unknown */);
 unknown_call("CF-L2-12 (call_func_ptr): %d\\n");
 call_func_ptr_array(/* arguments unknown */);
 local_m98 = 0x2F74;
 unknown_call(0x2F74);
 call_func_ptr_array(/* arguments unknown */);
 unknown_call(var_m98);
 local_m80 = global_2B48;
 local_m70 = global_2B58;
 process_with_callback(/* arguments unknown */);
 unknown_call("CF-L2-15 (process_with_callback): %d\\n");
 return;
}

/* raw-function-text: address=8584 name=non_local_jump state=PASS completeness=complete */
void non_local_jump(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m18 = a1;
 unknown_call(0x14058);
 if (call_205 != 0) {
 local_m14 = 0xFFFFFFFF;
 } else {
 if ((int32_t)var_8 < 0) {
 unknown_call(0x14058);
 }
 if ((int32_t)memory_unknown > 0x64) {
 unknown_call(0x14058);
 }
 memory_unknown = ((uint32_t)memory_unknown << 1);
 }
 return;
}

/* raw-function-text: address=8728 name=cpp_exception state=PASS completeness=complete */
void cpp_exception(void)
{
 local_m8 = a1;
 if ((int32_t)a1 >= 0) {
 if ((int32_t)a1 <= 0x64) {
 local_m4 = ((uint32_t)(uint32_t)a1 << 1);
 } else {
 local_m4 = 0xFFFFFFFE;
 }
 } else {
 local_m4 = 0xFFFFFFFF;
 }
 return;
}

/* raw-function-text: address=8820 name=large_jump_table state=PASS completeness=complete */
void large_jump_table(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m18 = a1;
 local_m1C = a2;
 local_m20 = a3;
 unknown_call(sp - 0x70);
 if (__arm64_condition_unknown(/* NZCV */)) {
 local_m14 = 0xFFFFFFFF;
 } else {
 if ((int32_t)var_m18 < 10) {
 unknown_call(var_m1C);
 local_m14 = call_213;
 } else {
 goto loc_22BC;
 }
 }
 return;
}

/* raw-function-text: address=8952 name=op_add state=PASS completeness=complete */
void op_add(void)
{
 local_m4 = a1;
 local_m8 = a2;
 return;
}

/* raw-function-text: address=8984 name=op_sub state=PASS completeness=complete */
void op_sub(void)
{
 local_m4 = a1;
 local_m8 = a2;
 return;
}

/* raw-function-text: address=9016 name=op_mul state=PASS completeness=complete */
void op_mul(void)
{
 local_m4 = a1;
 local_m8 = a2;
 return;
}

/* raw-function-text: address=9048 name=op_div state=PASS completeness=complete */
void op_div(void)
{
 local_m4 = a1;
 local_m8 = a2;
 if (a2 == 0) {
 local_mC = 0;
 } else {
 local_mC = (int32_t)((uint32_t)a2 == 0 ? 0 : (uint32_t)a1 / (uint32_t)a2);
 }
 return;
}

/* raw-function-text: address=9116 name=op_mod state=PASS completeness=complete */
void op_mod(void)
{
 local_m4 = a1;
 local_m8 = a2;
 if (a2 == 0) {
 local_mC = 0;
 } else {
 local_mC = var_93;
 }
 return;
}

/* raw-function-text: address=9192 name=op_and state=PASS completeness=complete */
void op_and(void)
{
 local_m4 = a1;
 local_m8 = a2;
 return;
}

/* raw-function-text: address=9224 name=op_or state=PASS completeness=complete */
void op_or(void)
{
 local_m4 = a1;
 local_m8 = a2;
 return;
}

/* raw-function-text: address=9256 name=op_xor state=PASS completeness=complete */
void op_xor(void)
{
 local_m4 = a1;
 local_m8 = a2;
 return;
}

/* raw-function-text: address=9288 name=op_shl state=PASS completeness=complete */
void op_shl(void)
{
 local_m4 = a1;
 local_m8 = a2;
 return;
}

/* raw-function-text: address=9320 name=op_shr state=PASS completeness=complete */
void op_shr(void)
{
 local_m4 = a1;
 local_m8 = a2;
 return;
}

/* raw-function-text: address=9352 name=conditional_func_ptr state=PASS completeness=complete */
void conditional_func_ptr(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m14 = a1;
 local_m18 = a2;
 if (var_m14 != 0) {
 if ((uint32_t)var_m14 != 1) {
 local_m20 = 0x1BFC;
 } else {
 local_m20 = 0x1E7C;
 }
 } else {
 local_m20 = 0x1E64;
 }
 unknown_call(var_8);
 return;
}

/* raw-function-text: address=9708 name=fsm_func_table state=PASS completeness=complete */
void fsm_func_table(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m18 = a1;
 local_m1C = a2;
 local_m40 = global_13D98;
 local_m30 = global_13DA8;
 if (__arm64_condition_unknown(/* NZCV */)) {
 local_m14 = 3;
 } else {
 if ((int32_t)var_m1C < 4) {
 unknown_call(var_m18);
 local_m14 = call_166;
 } else {
 goto loc_2634;
 }
 }
 return;
}

/* raw-function-text: address=9836 name=state_idle state=PASS completeness=complete */
void state_idle(void)
{
 local_m4 = a1;
 return;
}

/* raw-function-text: address=9868 name=state_processing state=PASS completeness=complete */
void state_processing(void)
{
 local_m8 = a1;
 if ((uint32_t)a1 != 2) {
 if ((uint32_t)a1 != 99) {
 local_m4 = 1;
 } else {
 local_m4 = 3;
 }
 } else {
 local_m4 = 2;
 }
 return;
}

/* raw-function-text: address=9956 name=state_done state=PASS completeness=complete */
void state_done(void)
{
 local_m4 = a1;
 return;
}

/* raw-function-text: address=9976 name=state_error state=PASS completeness=complete */
void state_error(void)
{
 local_m4 = a1;
 return;
}

/* raw-function-text: address=10172 name=obfuscated_cf state=PASS completeness=complete */
void obfuscated_cf(void)
{
 local_m4 = a1;
 local_m8 = (uint32_t)a1;
 if ((int32_t)(a1 * a1) + 1 < 0) {
 local_m8 = ((uint32_t)(uint32_t)a1 << 1) + 1;
 }
 local_m8 = ((uint32_t)local_m8 << 1);
 return;
}

/* raw-function-text: address=10260 name=opaque_predicate state=PASS completeness=complete */
void opaque_predicate(void)
{
 local_m8 = a1;
 local_mC = var_109;
 if (v125 != 0) {
 local_m4 = (uint32_t)a1 * 3;
 } else {
 local_m4 = ((uint32_t)(uint32_t)a1 << 1);
 }
 return;
}

/* raw-function-text: address=10372 name=overlapped_code state=PASS completeness=complete */
void overlapped_code(void)
{
 local_m8 = a1;
 if (bit_extract(a1, 0, 1) == 0) {
 local_m4 = (int32_t)(uint32_t)a1 / 2;
 } else {
 local_m4 = (uint32_t)a1 * 3 + 1;
 }
 return;
}

/* raw-function-text: address=10448 name=test_control_flow_l3 state=PASS completeness=complete */
void test_control_flow_l3(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 unknown_call("=== 测试极端控制流特征 ===\\n");
 local_m24 = 5;
 non_local_jump(/* arguments unknown */);
 local_m48 = 0x2FE3;
 unknown_call(0x2FE3);
 local_m3C = 0xFFFFFFFB;
 non_local_jump(/* arguments unknown */);
 unknown_call(var_m48);
 cpp_exception(/* arguments unknown */);
 local_m38 = 0x3002;
 unknown_call(0x3002);
 cpp_exception(/* arguments unknown */);
 unknown_call(var_m38);
 local_m30 = 0;
 large_jump_table(/* arguments unknown */);
 unknown_call("CF-L3-03 (large_jump_table): %d\\n");
 conditional_func_ptr(/* arguments unknown */);
 unknown_call("CF-L3-04 (conditional_func_ptr): %d\\n");
 local_m2C = 1;
 state_machine(/* arguments unknown */);
 unknown_call("CF-L3-05 (state_machine): %d\\n");
 local_m28 = 2;
 fsm_func_table(/* arguments unknown */);
 unknown_call("CF-L3-06 (fsm_func_table): %d\\n");
 local_m20 = global_3140;
 computed_goto(/* arguments unknown */);
 unknown_call("CF-L3-07 (computed_goto): %d\\n");
 obfuscated_cf(/* arguments unknown */);
 unknown_call("CF-L3-08 (obfuscated_cf): %d\\n");
 opaque_predicate(/* arguments unknown */);
 unknown_call("CF-L3-09 (opaque_predicate): %d\\n");
 overlapped_code(/* arguments unknown */);
 unknown_call("CF-L3-10 (overlapped_code): %d\\n");
 return;
}

/* raw-function-text: address=10832 name=main state=PASS completeness=complete */
void main(void)
{
 local_m10 = local_x29;
 local_m10 = local_x29;
 local_m18 = 0;
 local_m14 = 0;
 test_control_flow_l1(/* arguments unknown */);
 test_control_flow_l2(/* arguments unknown */);
 test_control_flow_l3(/* arguments unknown */);
 return;
}

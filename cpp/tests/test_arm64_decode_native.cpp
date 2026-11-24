#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <vector>

#include "../src/targets/arm64_decode.hpp"

namespace {

struct OracleRow {
  uint32_t word;
  uint64_t pc;
  uint8_t kind;
  const char* kind_name;
  uint8_t rd;
  uint8_t rn;
  uint8_t rm;
  uint8_t has_target;
  uint64_t target;
  uint8_t has_pc_rel;
  uint8_t pc_rel_reg;
  uint8_t pc_rel_page;
  uint64_t pc_rel_val;
  uint8_t has_memory;
  uint8_t mem_load;
  uint8_t mem_store;
  uint8_t mem_size;
  uint8_t mem_base;
  uint8_t mem_has_disp;
  int64_t mem_disp;
  uint8_t has_cmp;
  int64_t cmp_imm;
};

static const OracleRow kRealElfOracle[86] = {
  {0x12800000U, 0x1000ULL, 3, "MOVIMM", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x11000400U, 0x1004ULL, 5, "ARITH", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x1008ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xf100001fU, 0x100cULL, 16, "CMP", 31, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 1, 0LL},
  {0x54000060U, 0x1010ULL, 17, "CONDBR", 0, 3, 0, 1, 0x101cULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x91000400U, 0x1014ULL, 5, "ARITH", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x14000002U, 0x1018ULL, 18, "BRANCH", 2, 0, 0, 1, 0x1020ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd1000400U, 0x101cULL, 5, "ARITH", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x1020ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd10043ffU, 0x1024ULL, 5, "ARITH", 31, 31, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xf90003e0U, 0x1028ULL, 15, "STORE", 0, 31, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 0, 1, 8, 31, 1, 0LL, 0, 0LL},
  {0xf94003e1U, 0x102cULL, 14, "LOAD", 1, 31, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 1, 0, 8, 31, 1, 0LL, 0, 0LL},
  {0x91000820U, 0x1030ULL, 5, "ARITH", 0, 1, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x910043ffU, 0x1034ULL, 5, "ARITH", 31, 31, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x1038ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xa9bf7bfdU, 0x103cULL, 15, "STORE", 29, 31, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 0, 1, 16, 31, 1, -16LL, 0, 0LL},
  {0x910003fdU, 0x1040ULL, 4, "MOVREG", 29, 31, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xaa0103e0U, 0x1044ULL, 4, "MOVREG", 0, 31, 1, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xaa0203e1U, 0x1048ULL, 4, "MOVREG", 1, 31, 2, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x94000004U, 0x104cULL, 19, "CALL", 4, 0, 0, 1, 0x105cULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x91000400U, 0x1050ULL, 5, "ARITH", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xa8c17bfdU, 0x1054ULL, 14, "LOAD", 29, 31, 1, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 1, 0, 16, 31, 1, 16LL, 0, 0LL},
  {0xd65f03c0U, 0x1058ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x8b010000U, 0x105cULL, 5, "ARITH", 0, 0, 1, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x1060ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xc87f8440U, 0x1064ULL, 23, "ATOMIC", 0, 2, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 1, 0, 16, 2, 1, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x1068ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x1e622820U, 0x1000ULL, 10, "FARITH", 0, 1, 2, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x1004ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x1e612000U, 0x1008ULL, 16, "CMP", 0, 0, 1, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x54000060U, 0x100cULL, 17, "CONDBR", 0, 3, 0, 1, 0x1018ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x1e623820U, 0x1010ULL, 10, "FARITH", 0, 1, 2, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x1014ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x1e620820U, 0x1018ULL, 11, "FMUL", 0, 1, 2, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x101cULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x4ea28420U, 0x1020ULL, 13, "SIMD", 0, 1, 2, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x1024ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xc8dffc20U, 0x1028ULL, 23, "ATOMIC", 0, 1, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 1, 0, 8, 1, 1, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x102cULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xc89ffc20U, 0x1030ULL, 23, "ATOMIC", 0, 1, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 0, 1, 8, 1, 1, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x1034ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xc85f7c20U, 0x1038ULL, 23, "ATOMIC", 0, 1, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 1, 0, 8, 1, 1, 0LL, 0, 0LL},
  {0xc8027c20U, 0x103cULL, 23, "ATOMIC", 0, 1, 2, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 0, 1, 8, 1, 1, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x1040ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd283fe09U, 0x1000ULL, 3, "MOVIMM", 9, 16, 3, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x91004129U, 0x1004ULL, 5, "ARITH", 9, 9, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xf90003e9U, 0x1008ULL, 15, "STORE", 9, 31, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 0, 1, 8, 31, 1, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x100cULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x91000400U, 0x1010ULL, 5, "ARITH", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x1014ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xa9bf7bfdU, 0x1000ULL, 15, "STORE", 29, 31, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 0, 1, 16, 31, 1, -16LL, 0, 0LL},
  {0xd2821009U, 0x1004ULL, 3, "MOVIMM", 9, 0, 2, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x9240000aU, 0x1008ULL, 8, "LOGIC", 10, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd37df14aU, 0x100cULL, 9, "SHIFT", 10, 10, 29, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x8b0a0129U, 0x1010ULL, 5, "ARITH", 9, 9, 10, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xf940012bU, 0x1014ULL, 14, "LOAD", 11, 9, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 1, 0, 8, 9, 1, 0LL, 0, 0LL},
  {0xd63f0160U, 0x1018ULL, 20, "INDCALL", 0, 11, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xa8c17bfdU, 0x101cULL, 14, "LOAD", 29, 31, 1, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 1, 1, 0, 16, 31, 1, 16LL, 0, 0LL},
  {0xd65f03c0U, 0x1020ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd503201fU, 0x1024ULL, 1, "NOP", 31, 0, 3, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd503201fU, 0x1028ULL, 1, "NOP", 31, 0, 3, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd503201fU, 0x102cULL, 1, "NOP", 31, 0, 3, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x91000400U, 0x1030ULL, 5, "ARITH", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x1034ULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd1000400U, 0x1038ULL, 5, "ARITH", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0xd65f03c0U, 0x103cULL, 21, "RET", 0, 30, 31, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1040ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1044ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1048ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x104cULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1050ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1054ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1058ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x105cULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1060ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1064ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1068ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x106cULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1070ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1074ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1078ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x107cULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x1030U, 0x1080ULL, 25, "TRAP", 16, 1, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x1084ULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x1038U, 0x1088ULL, 25, "TRAP", 24, 1, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
  {0x0U, 0x108cULL, 0, "OTHER", 0, 0, 0, 0, 0x0ULL, 0, 0, 0, 0x0ULL, 0, 0, 0, 0, 0, 0, 0LL, 0, 0LL},
};

static std::vector<uint32_t> read_elf_words(const char* path, size_t offset, size_t byte_len) {
  std::ifstream ifs(path, std::ios::binary);
  assert(ifs.good() && "failed to open ARM64 ELF fixture");
  ifs.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
  std::vector<uint8_t> raw(byte_len);
  ifs.read(reinterpret_cast<char*>(raw.data()), static_cast<std::streamsize>(byte_len));
  assert(static_cast<size_t>(ifs.gcount()) == byte_len);
  std::vector<uint32_t> out(byte_len / 4u);
  for (size_t i = 0; i < out.size(); ++i) {
    out[i] = static_cast<uint32_t>(raw[i * 4u]) |
             (static_cast<uint32_t>(raw[i * 4u + 1u]) << 8) |
             (static_cast<uint32_t>(raw[i * 4u + 2u]) << 16) |
             (static_cast<uint32_t>(raw[i * 4u + 3u]) << 24);
  }
  return out;
}

static void test_real_elf_binaries_oracle_parity() {
  struct BinSpec { const char* path; size_t off; size_t len; uint64_t base; };
  static constexpr BinSpec kBins[4] = {
      {"tests/scpa/fixtures/arm64-real-byte-semantic-holdout.elf", 0x1000u, 108u, 0x1000ULL},
      {"tests/scpa/fixtures/arm64-real-byte-fpsimd-atomic-holdout.elf", 0x1000u, 68u, 0x1000ULL},
      {"tests/scpa/fixtures/threaded-integer.elf", 0x1000u, 24u, 0x1000ULL},
      {"tests/scpa/fixtures/dispatch-table.elf", 0x1000u, 144u, 0x1000ULL},
  };

  size_t oracle_idx = 0u;
  for (const auto& bin : kBins) {
    const auto words = read_elf_words(bin.path, bin.off, bin.len);
    std::vector<HexArm64Decoded> decoded(words.size());
    std::vector<uint8_t> kinds(words.size());
    assert(hex_arm64_decode_batch(words.data(), static_cast<uint32_t>(words.size()),
                                  bin.base, decoded.data()) == HEX_OK);
    assert(hex_arm64_classify_batch(words.data(), static_cast<uint32_t>(words.size()),
                                    kinds.data()) == HEX_OK);

    for (size_t i = 0; i < words.size(); ++i, ++oracle_idx) {
      const OracleRow& exp = kRealElfOracle[oracle_idx];
      const HexArm64Decoded& d = decoded[i];
      assert(d.word == exp.word);
      assert(d.pc == exp.pc);
      assert(d.kind == exp.kind);
      assert(kinds[i] == exp.kind);
      assert(hex_arm64_classify_word(exp.word) == exp.kind);
      assert(std::strcmp(hex_arm64_kind_name(d.kind), exp.kind_name) == 0);
      assert(d.rd == exp.rd);
      assert(d.rn == exp.rn);
      assert(d.rm == exp.rm);
      assert(d.has_target == exp.has_target);
      if (exp.has_target) assert(d.target == exp.target);
      assert(d.has_pc_rel == exp.has_pc_rel);
      if (exp.has_pc_rel) {
        assert(d.pc_rel.valid == 1u);
        assert(d.pc_rel.reg == exp.pc_rel_reg);
        assert(d.pc_rel.page == exp.pc_rel_page);
        assert(d.pc_rel.value == exp.pc_rel_val);
      }
      assert(d.has_memory == exp.has_memory);
      if (exp.has_memory) {
        assert(d.memory.valid == 1u);
        assert(d.memory.load == exp.mem_load);
        assert(d.memory.store == exp.mem_store);
        assert(d.memory.size == exp.mem_size);
        assert(d.memory.base == exp.mem_base);
        assert(d.memory.has_disp == exp.mem_has_disp);
        if (exp.mem_has_disp) assert(d.memory.disp == exp.mem_disp);
      }
      assert(d.has_compare_with == exp.has_cmp);
      if (exp.has_cmp) assert(d.compare_with == exp.cmp_imm);
      if (d.kind != HEX_ARM64_KIND_TRAP) {
        assert(std::strcmp(d.mn, "udf") != 0);
      }
    }
  }
  assert(oracle_idx == 86u);
}

static void test_capability_table_and_decompiler_gate() {
  // Capability table checks
  assert(hex_arm64_kind_capability(HEX_ARM64_KIND_MOVIMM) == HEX_ARM64_CAP_DECOMP);
  assert(hex_arm64_kind_capability(HEX_ARM64_KIND_MOVREG) == HEX_ARM64_CAP_DECOMP);
  assert(hex_arm64_kind_capability(HEX_ARM64_KIND_ARITH) == HEX_ARM64_CAP_DECOMP);
  assert(hex_arm64_kind_capability(HEX_ARM64_KIND_MUL) == HEX_ARM64_CAP_DECOMP);
  assert(hex_arm64_kind_capability(HEX_ARM64_KIND_RET) == HEX_ARM64_CAP_DECOMP);
  assert(hex_arm64_kind_capability(HEX_ARM64_KIND_LOAD) == HEX_ARM64_CAP_FALLBACK);
  assert(hex_arm64_kind_capability(HEX_ARM64_KIND_ATOMIC) == HEX_ARM64_CAP_FALLBACK);
  assert(hex_arm64_kind_capability(HEX_ARM64_KIND_SIMD) == HEX_ARM64_CAP_FALLBACK);
  assert(hex_arm64_kind_capability(255u) == HEX_ARM64_CAP_FALLBACK);

  // Supported exact-parity instructions -> 1
  assert(hex_arm64_is_decompiler_supported(0xd65f03c0U) == 1);  // ret
  assert(hex_arm64_is_decompiler_supported(0x0b010000U) == 1);  // add w0, w0, w1
  assert(hex_arm64_is_decompiler_supported(0xcb010000U) == 1);  // sub x0, x0, x1
  assert(hex_arm64_is_decompiler_supported(0x1b017c00U) == 1);  // mul w0, w0, w1
  assert(hex_arm64_is_decompiler_supported(0xaa0103e0U) == 1);  // mov x0, x1 (orr x0, xzr, x1)
  assert(hex_arm64_is_decompiler_supported(0x52800020U) == 1);  // movz w0, #1
  assert(hex_arm64_is_decompiler_supported(0x92800000U) == 1);  // movn x0, #0

  // Wave 4 strict gate rejections -> 0 (must fall back)
  assert(hex_arm64_is_decompiler_supported(0xb2401fe0U) == 0);  // ORR imm (mov x0, #0xff)
  assert(hex_arm64_is_decompiler_supported(0x1e6e1000U) == 0);  // FMOV d0, #1.0
  assert(hex_arm64_is_decompiler_supported(0xf2800020U) == 0);  // MOVK x0, #1
  assert(hex_arm64_is_decompiler_supported(0x1b01fc00U) == 0);  // MNEG/MSUB w0, w0, w1
  assert(hex_arm64_is_decompiler_supported(0x9b217c00U) == 0);  // SMULL x0, w0, w1
  assert(hex_arm64_is_decompiler_supported(0x1b010800U) == 0);  // MADD w0, w0, w1, w2 (ra != 31)
  assert(hex_arm64_is_decompiler_supported(0x910003e0U) == 0);  // MOV x0, sp (group 8)
  assert(hex_arm64_is_decompiler_supported(0x91004000U) == 0);  // ADD x0, x0, #0x10 (imm)
  assert(hex_arm64_is_decompiler_supported(0xd65f0bffU) == 0);  // RETAA (PAC)
}

static void test_issue_regressions_and_formatting() {
  // #3936: pairedOffset ADD (immediate) LSL #12
  {
    HexArm64PairedOffset po{};
    assert(hex_arm64_paired_offset(0x91400400U, &po) == 1);
    assert(po.rn == 0 && po.rd == 0 && po.imm == 0x1000ULL && po.load == 0);
    assert(hex_arm64_paired_offset(0x91000400U, &po) == 1);
    assert(po.imm == 1ULL);
  }
  // #3975: FEAT_MTE STGP pair scale
  {
    HexArm64MemAccess m{};
    assert(hex_arm64_memory_access(0x69008440U, &m) == 1);
    assert(m.store == 1 && m.pair == 1 && m.element_size == 8 && m.size == 16 && m.disp == 16 && m.tag == 1);
    assert(hex_arm64_memory_access(0x693f8440U, &m) == 1);
    assert(m.disp == -16 && m.tag == 1);
  }
  // #4032: PC-relative uint64 wraparound
  {
    uint64_t tgt = 0;
    assert(hex_arm64_branch_imm26(0x17ffffffU, 0ULL, &tgt) == 1 && tgt == 0xfffffffffffffffcULL);
    assert(hex_arm64_literal_target(0x58ffffe0U, 0ULL, &tgt) == 1 && tgt == 0xfffffffffffffffcULL);
    HexArm64PcRel pr{};
    assert(hex_arm64_pc_rel_target(0x70ffffe0U, 0ULL, &pr) == 1 && pr.page == 0 && pr.value == 0xffffffffffffffffULL);
    assert(hex_arm64_pc_rel_target(0xf0ffffe0U, 0ULL, &pr) == 1 && pr.page == 1 && pr.value == 0xfffffffffffff000ULL);
  }
  // #4180: PAC branches & returns
  {
    assert(hex_arm64_classify_word(0xd71f0801U) == HEX_ARM64_KIND_BRANCH);
    assert(hex_arm64_classify_word(0xd65f0bffU) == HEX_ARM64_KIND_RET);
    assert(hex_arm64_classify_word(0xd73f0801U) == HEX_ARM64_KIND_INDCALL);
  }
  // #9629: Fixed-point FP conversions
  {
    assert(hex_arm64_classify_word(0x1e02fc00U) == HEX_ARM64_KIND_FCONV);
    assert(hex_arm64_classify_word(0x9e42c020U) == HEX_ARM64_KIND_FCONV);
  }
  // Formatting: post-index disp==0 keeps ", #0x0"; unformatted valid insn is "" not "udf"
  {
    HexArm64Decoded d{};
    assert(hex_arm64_decode_word(0xf8400420U, 0x1000ULL, &d) == HEX_OK);
    assert(std::strcmp(d.mn, "ldr") == 0 && std::strcmp(d.ops, "x0, [x1], #0x0") == 0);
    assert(hex_arm64_decode_word(0x9ac10c00U, 0x1000ULL, &d) == HEX_OK);
    assert(d.kind == HEX_ARM64_KIND_DIV && std::strcmp(d.mn, "") == 0);
    assert(hex_arm64_decode_word(0x00000001U, 0x1000ULL, &d) == HEX_OK);
    assert(d.kind == HEX_ARM64_KIND_TRAP && std::strcmp(d.mn, "udf") == 0 && std::strcmp(d.ops, "#0x1") == 0);
  }
}

}  // namespace

int main() {
  test_real_elf_binaries_oracle_parity();
  test_capability_table_and_decompiler_gate();
  test_issue_regressions_and_formatting();
  std::printf("test_arm64_decode_native (86 real ELF words + capability gate + regressions, ASan+UBSan): ALL PASS\n");
  return 0;
}

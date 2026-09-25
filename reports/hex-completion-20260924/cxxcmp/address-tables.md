# Same-address C++ vtable and indirect-call comparison

Generated from the supplied real-game artifacts only. No game was rerun. The full slot table is address-joined over every vtable record in each `result.json` class sample. `oracleOwnerExact` means the result class label exactly matches a line in independent `oracle-classes.txt`; it is a name check, not a per-address DWARF slot oracle.

## Vtable slot counts by address

`delta = final 3180 slot count − old c34d slot count`. A boundary target is taken from the old row’s `slotTargets` at the first index at or after the final count whose symbol is RTTI/typeinfo. `+0` is a direct RTTI/typeinfo symbol at the first omitted index; `+1` is an RTTI/typeinfo target one word after the new end, consistent with the adjacent offset-to-top/typeinfo header. Full symbol labels are preserved in `address-comparison.json`.

### openmw

The staged scan and saved result each cover 300/300 sampled classes. Recorded vtable addresses: 216 old / 216 final; shared 216. Changed 202, unchanged 14, increased 0, old-only 0, final-only 0. Slot sum 6912 → 1913 (-4999). Immediate RTTI boundary offsets: {"0":47,"1":155}.

| vtable address | result class label | old slots | final slots | Δ | owner in oracle class list | first post-end RTTI evidence |
|---:|---|---:|---:|---:|:---:|---|
| `22984088` | btTriangleInfoMap | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23077856 — typeinfo for boost::system::detail::generic_error_category |
| `22984136` | boost::system::detail::generic_error_category | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23077880 — typeinfo for boost::system::detail::system_error_category |
| `22984208` | boost::system::detail::system_error_category | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23077904 — typeinfo for boost::system::detail::interop_error_category |
| `22984280` | boost::system::detail::interop_error_category | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23077928 — _ZTIN8Resource22GenericResourceManagerISt5tupleIJN3osg5Vec2fEfbEEEE |
| `22988696` | boost::filesystem::basic_ifstream<char, std, char_traits, <char>> | 32 | 0 | -32 | no exact match | slot 0 (at new end (+0)): 23200616 — typeinfo for boost::filesystem::basic_ifstream<char, std, char_traits, <char>> |
| `23042864` | GetCellStoreCallback | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23318552 — typeinfo for MWWorld::ActionOpen |
| `23044416` | btCollisionWorld::ClosestConvexResultCallback | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23321736 — typeinfo for MWPhysics::PhysicsSystem |
| `23045016` | btCollisionWorld::ClosestRayResultCallback | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23322128 — typeinfo for MWPhysics::ContactCollectionCallback |
| `23046136` | ESM::AiSequence::AiPursue | 32 | 2 | -30 | yes | slot 3 (one word after new end (+1)): 23341272 — typeinfo for MWMechanics::AiPursue |
| `23046304` | ESM::AiSequence::AiWander | 32 | 2 | -30 | yes | slot 3 (one word after new end (+1)): 23341520 — typeinfo for ESM::AiSequence::AiTravel |
| `23046336` | ESM::AiSequence::AiTravel | 32 | 2 | -30 | yes | slot 3 (one word after new end (+1)): 23341744 — typeinfo for ESM::AiSequence::AiFollow |
| `23046368` | ESM::AiSequence::AiFollow | 32 | 2 | -30 | yes | slot 3 (one word after new end (+1)): 23342152 — typeinfo for MWMechanics::AiCast |
| `23046488` | ESM::AiSequence::AiEscort | 32 | 2 | -30 | yes | slot 3 (one word after new end (+1)): 23342536 — typeinfo for ESM::AiSequence::AiActivate |
| `23046520` | ESM::AiSequence::AiActivate | 32 | 2 | -30 | yes | slot 3 (one word after new end (+1)): 23342648 — typeinfo for MWMechanics::AiCombatStorage |
| `23046584` | ESM::AiSequence::AiCombat | 32 | 2 | -30 | yes | slot 3 (one word after new end (+1)): 23342736 — typeinfo for MWMechanics::ActionFlee |
| `23047344` | boost::filesystem::basic_ofstream<char, std, char_traits, <char>> | 32 | 0 | -32 | no exact match | slot 0 (at new end (+0)): 23343072 — typeinfo for boost::filesystem::basic_ofstream<char, std, char_traits, <char>> |
| `23047424` | boost::bad_any_cast | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23343336 — typeinfo for boost::wrapexcept<boost::bad_any_cast> |
| `23047464` | boost::wrapexcept<boost::bad_any_cast> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23343336 — typeinfo for boost::wrapexcept<boost::bad_any_cast> |
| `23047760` | boost::bad_lexical_cast | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23345864 — typeinfo for boost::any::holder<std, vector, <Files::MaybeQuotedPath, std::allocator, <Files::MaybeQuotedPath>>> |
| `23047800` | boost::any::holder<std, vector, <Files::MaybeQuotedPath, std::allocator, <Files::MaybeQuotedPath>>> | 32 | 4 | -28 | no exact match | slot 5 (one word after new end (+1)): 23345888 — typeinfo for boost::any::holder<Files::MaybeQuotedPath> |
| `23047848` | boost::any::holder<Files::MaybeQuotedPath> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23345912 — _ZTIN5boost3any6holderISt6vectorINSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEESaIS8_EEEE |
| `23047944` | boost::any::holder<std::__cxx11::basic_string<char, std, char_traits, <char>, std::allocator, <char>>> | 32 | 4 | -28 | no exact match | slot 5 (one word after new end (+1)): 23345960 — typeinfo for boost::any::holder<bool> |
| `23047992` | boost::any::holder<bool> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23345984 — typeinfo for boost::any::holder<int> |
| `23048040` | boost::any::holder<int> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23346008 — typeinfo for boost::any::holder<Fallback::FallbackMap> |
| `23048088` | boost::any::holder<Fallback::FallbackMap> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23346032 — typeinfo for boost::any::holder<unsigned int> |
| `23048136` | boost::any::holder<unsigned int> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23346056 — typeinfo for boost::wrapexcept<boost::bad_lexical_cast> |
| `23048184` | boost::wrapexcept<boost::bad_lexical_cast> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23346056 — typeinfo for boost::wrapexcept<boost::bad_lexical_cast> |
| `23064008` | ESM::ObjectState | 32 | 15 | -17 | yes | slot 16 (one word after new end (+1)): 23573304 — typeinfo for ESM::InventoryState |
| `23064144` | ESM::InventoryState | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23574696 — typeinfo for Stereo::Texture2DViewSubloadCallback |
| `23064680` | Debug::DebugOutputBase | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23586560 — typeinfo for Debug::Tee |
| `23064728` | Debug::Tee | 32 | 5 | -27 | yes | slot 5 (at new end (+0)): 23587432 — _ZTIN3osg17GraphicsOperationE+0x8 |
| `23064824` | Files::ConfigurationManager | 32 | 2 | -30 | yes | slot 3 (one word after new end (+1)): 23588496 — _ZTISt19_Sp_counted_deleterIPSiN5boost15program_options6detail12null_deleterESaIvELN9__gnu_cxx12_Lock_policyE2EE |
| `23064992` | Compiler::GetArgumentsFromMessageFormat | 32 | 5 | -27 | yes | slot 6 (one word after new end (+1)): 23250632 — typeinfo for Compiler::SourceException |
| `23065048` | Compiler::SourceException | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23589880 — typeinfo for Compiler::EOFException |
| `23065088` | Compiler::EOFException | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23589864 — typeinfo for Compiler::Parser |
| `23065128` | Compiler::Parser | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23065744` | Interpreter::OpPushInt | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23590848 — typeinfo for Interpreter::OpIntToFloat |
| `23065784` | Interpreter::OpIntToFloat | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23590872 — typeinfo for Interpreter::OpFloatToInt |
| `23065824` | Interpreter::OpFloatToInt | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23590896 — typeinfo for Interpreter::OpNegateInt |
| `23065864` | Interpreter::OpNegateInt | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23590920 — typeinfo for Interpreter::OpNegateFloat |
| `23065904` | Interpreter::OpNegateFloat | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23590944 — typeinfo for Interpreter::OpIntToFloat1 |
| `23065944` | Interpreter::OpIntToFloat1 | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23590968 — typeinfo for Interpreter::OpFloatToInt1 |
| `23065984` | Interpreter::OpFloatToInt1 | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23590992 — typeinfo for Interpreter::OpStoreLocalShort |
| `23066024` | Interpreter::OpStoreLocalShort | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591016 — typeinfo for Interpreter::OpStoreLocalLong |
| `23066064` | Interpreter::OpStoreLocalLong | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591040 — typeinfo for Interpreter::OpStoreLocalFloat |
| `23066104` | Interpreter::OpStoreLocalFloat | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591064 — typeinfo for Interpreter::OpFetchIntLiteral |
| `23066144` | Interpreter::OpFetchIntLiteral | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591088 — typeinfo for Interpreter::OpFetchFloatLiteral |
| `23066184` | Interpreter::OpFetchFloatLiteral | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591112 — typeinfo for Interpreter::OpFetchLocalShort |
| `23066224` | Interpreter::OpFetchLocalShort | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591136 — typeinfo for Interpreter::OpFetchLocalLong |
| `23066264` | Interpreter::OpFetchLocalLong | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591160 — typeinfo for Interpreter::OpFetchLocalFloat |
| `23066304` | Interpreter::OpFetchLocalFloat | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591184 — typeinfo for Interpreter::OpStoreGlobalShort |
| `23066344` | Interpreter::OpStoreGlobalShort | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591208 — typeinfo for Interpreter::OpStoreGlobalLong |
| `23066384` | Interpreter::OpStoreGlobalLong | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591232 — typeinfo for Interpreter::OpStoreGlobalFloat |
| `23066424` | Interpreter::OpStoreGlobalFloat | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591256 — typeinfo for Interpreter::OpFetchGlobalShort |
| `23066464` | Interpreter::OpFetchGlobalShort | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591280 — typeinfo for Interpreter::OpFetchGlobalLong |
| `23066504` | Interpreter::OpFetchGlobalLong | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591304 — typeinfo for Interpreter::OpFetchGlobalFloat |
| `23066544` | Interpreter::OpFetchGlobalFloat | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591328 — typeinfo for Interpreter::OpReturn |
| `23066584` | Interpreter::OpReturn | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591352 — typeinfo for Interpreter::OpSkipZero |
| `23066624` | Interpreter::OpSkipZero | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591376 — typeinfo for Interpreter::OpSkipNonZero |
| `23066664` | Interpreter::OpSkipNonZero | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591400 — typeinfo for Interpreter::OpJumpForward |
| `23066704` | Interpreter::OpJumpForward | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591424 — typeinfo for Interpreter::OpJumpBackward |
| `23066744` | Interpreter::OpJumpBackward | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591448 — typeinfo for Interpreter::RuntimeMessageFormatter |
| `23066784` | Interpreter::RuntimeMessageFormatter | 32 | 5 | -27 | yes | slot 6 (one word after new end (+1)): 23591472 — typeinfo for Interpreter::OpMessageBox |
| `23066840` | Interpreter::OpMessageBox | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591496 — typeinfo for Interpreter::OpReport |
| `23066880` | Interpreter::OpReport | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591520 — _ZTIN11Interpreter18OpStoreMemberShortILb0EEE |
| `23067400` | Interpreter::OpAddInt<int> | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591832 — typeinfo for Interpreter::OpAddInt<float> |
| `23067440` | Interpreter::OpAddInt<float> | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591856 — typeinfo for Interpreter::OpSubInt<int> |
| `23067480` | Interpreter::OpSubInt<int> | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591880 — typeinfo for Interpreter::OpSubInt<float> |
| `23067520` | Interpreter::OpSubInt<float> | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591904 — typeinfo for Interpreter::OpMulInt<int> |
| `23067560` | Interpreter::OpMulInt<int> | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591928 — typeinfo for Interpreter::OpMulInt<float> |
| `23067600` | Interpreter::OpMulInt<float> | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591952 — typeinfo for Interpreter::OpDivInt<int> |
| `23067640` | Interpreter::OpDivInt<int> | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23591976 — typeinfo for Interpreter::OpDivInt<float> |
| `23067680` | Interpreter::OpDivInt<float> | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23592000 — typeinfo for Interpreter::OpCompare<int, std, equal_to, <int>> |
| `23067720` | Interpreter::OpCompare<int, std, equal_to, <int>> | 32 | 3 | -29 | no exact match | slot 4 (one word after new end (+1)): 23592024 — typeinfo for Interpreter::OpCompare<int, std, not_equal_to, <int>> |
| `23067760` | Interpreter::OpCompare<int, std, not_equal_to, <int>> | 32 | 3 | -29 | no exact match | slot 4 (one word after new end (+1)): 23592048 — typeinfo for Interpreter::OpCompare<int, std, less, <int>> |
| `23067800` | Interpreter::OpCompare<int, std, less, <int>> | 32 | 3 | -29 | no exact match | slot 4 (one word after new end (+1)): 23592072 — typeinfo for Interpreter::OpCompare<int, std, less_equal, <int>> |
| `23067840` | Interpreter::OpCompare<int, std, less_equal, <int>> | 32 | 3 | -29 | no exact match | slot 4 (one word after new end (+1)): 23592096 — typeinfo for Interpreter::OpCompare<int, std, greater, <int>> |
| `23067880` | Interpreter::OpCompare<int, std, greater, <int>> | 32 | 3 | -29 | no exact match | slot 4 (one word after new end (+1)): 23592120 — typeinfo for Interpreter::OpCompare<int, std, greater_equal, <int>> |
| `23067920` | Interpreter::OpCompare<int, std, greater_equal, <int>> | 32 | 3 | -29 | no exact match | slot 4 (one word after new end (+1)): 23592144 — typeinfo for Interpreter::OpCompare<float, std, equal_to, <float>> |
| `23067960` | Interpreter::OpCompare<float, std, equal_to, <float>> | 32 | 3 | -29 | no exact match | slot 4 (one word after new end (+1)): 23592168 — typeinfo for Interpreter::OpCompare<float, std, not_equal_to, <float>> |
| `23068000` | Interpreter::OpCompare<float, std, not_equal_to, <float>> | 32 | 3 | -29 | no exact match | slot 4 (one word after new end (+1)): 23592192 — typeinfo for Interpreter::OpCompare<float, std, less, <float>> |
| `23068040` | Interpreter::OpCompare<float, std, less, <float>> | 32 | 3 | -29 | no exact match | slot 4 (one word after new end (+1)): 23592216 — typeinfo for Interpreter::OpCompare<float, std, less_equal, <float>> |
| `23068080` | Interpreter::OpCompare<float, std, less_equal, <float>> | 32 | 3 | -29 | no exact match | slot 4 (one word after new end (+1)): 23592240 — typeinfo for Interpreter::OpCompare<float, std, greater, <float>> |
| `23068120` | Interpreter::OpCompare<float, std, greater, <float>> | 32 | 3 | -29 | no exact match | slot 4 (one word after new end (+1)): 23592264 — typeinfo for Interpreter::OpCompare<float, std, greater_equal, <float>> |
| `23068160` | Interpreter::OpCompare<float, std, greater_equal, <float>> | 32 | 5 | -27 | no exact match | slot 5 (at new end (+0)): 23592376 — _ZTIN7Terrain18HeightCullCallbackE+0x30 |
| `23071040` | DetourNavigator::NavigatorStub | 32 | 28 | -4 | yes | slot 28 (at new end (+0)): 23626736 — _ZTISi+0x8 |
| `23071344` | Files::StreamWithBuffer<Bsa::MemoryInputStream> | 32 | 0 | -32 | yes | slot 0 (at new end (+0)): 23626424 — typeinfo for Files::StreamWithBuffer<Bsa::MemoryInputStream> |
| `23071424` | boost::detail::sp_counted_impl_p<boost::iostreams::symmetric_filter<boost::iostreams::detail::zlib_decompressor_impl<std::allocator, <char>>, boost::iostreams::detail::zlib_decompressor_impl<std::allocator, <char>>>::impl> | 32 | 7 | -25 | no exact match | slot 8 (one word after new end (+1)): 23626640 — _ZTIN5boost6detail17sp_counted_impl_pINS_9iostreams6detail10chain_baseINS2_5chainINS2_5inputEcSt11char_traitsIcESaIcEEEcS8_S9_S6_E10chain_implEEE |
| `23075784` | Files::StreamWithBuffer<Files::ConstrainedFileStreamBuf> | 32 | 0 | -32 | yes | slot 0 (at new end (+0)): 23633960 — typeinfo for Files::StreamWithBuffer<Files::ConstrainedFileStreamBuf> |
| `23076384` | DetourNavigator::NavigatorImpl | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23076752` | Bsa::BSAFile | 32 | 5 | -27 | yes | slot 5 (at new end (+0)): 23636936 — _ZTISt13basic_fstreamIcSt11char_traitsIcEE+0x8 |
| `23076904` | boost::filesystem::basic_fstream<char, std, char_traits, <char>> | 32 | 0 | -32 | no exact match | slot 0 (at new end (+0)): 23636608 — typeinfo for boost::filesystem::basic_fstream<char, std, char_traits, <char>> |
| `23079752` | boost::system::error_category | 32 | 8 | -24 | yes | slot 9 (one word after new end (+1)): 23077584 — typeinfo for osg::Callback |
| `23185096` | Files::MemBuf | 32 | 26 | -6 | yes | slot 27 (one word after new end (+1)): 23184992 — typeinfo for Files::IMemStream |
| `23185304` | Files::IMemStream | 32 | 0 | -32 | yes | slot 1 (one word after new end (+1)): 23184992 — typeinfo for Files::IMemStream |
| `23253952` | __cxxabiv1::__pointer_to_member_type_info | 32 | 0 | -32 | no exact match | slot 1 (one word after new end (+1)): 23241152 — _ZTIFvPN5MyGUI6WidgetEE |
| `23261744` | icu_74::StringByteSink<std::__cxx11::basic_string<char, std, char_traits, <char>, std::allocator, <char>>> | 32 | 6 | -26 | no exact match | slot 6 (at new end (+0)): 19779936 — _ZTSMN5MWGui18ConfirmationDialogEFvPN5MyGUI6WidgetEE |
| `23285896` | fx::Widgets::EditBase | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23285136 — typeinfo for fx::Widgets::EditNumber<float, osg::Vec4f> |
| `23285944` | fx::Widgets::EditNumber<float, osg::Vec4f> | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23285136 — typeinfo for fx::Widgets::EditNumber<float, osg::Vec4f> |
| `23286560` | fx::Widgets::EditNumberFloat4 | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23285192 — typeinfo for fx::Widgets::EditNumberFloat4 |
| `23287176` | fx::Widgets::EditNumber<float, osg::Vec3f> | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23285216 — typeinfo for fx::Widgets::EditNumber<float, osg::Vec3f> |
| `23287792` | fx::Widgets::EditNumberFloat3 | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23285272 — typeinfo for fx::Widgets::EditNumberFloat3 |
| `23288408` | fx::Widgets::EditNumber<float, osg::Vec2f> | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23285296 — typeinfo for fx::Widgets::EditNumber<float, osg::Vec2f> |
| `23289024` | fx::Widgets::EditNumberFloat2 | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23285352 — typeinfo for fx::Widgets::EditNumberFloat2 |
| `23289640` | fx::Widgets::EditNumber<float, float> | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23285376 — typeinfo for fx::Widgets::EditNumber<float, float> |
| `23290256` | fx::Widgets::EditNumberFloat | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23285432 — typeinfo for fx::Widgets::EditNumberFloat |
| `23290872` | fx::Widgets::EditNumber<int, int> | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23285456 — typeinfo for fx::Widgets::EditNumber<int, int> |
| `23291488` | fx::Widgets::EditNumberInt | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23285512 — typeinfo for fx::Widgets::EditNumberInt |
| `23343408` | boost::exception | 32 | 2 | -30 | yes | slot 3 (one word after new end (+1)): 23343272 — typeinfo for boost::exception_detail::clone_base |
| `23343440` | boost::exception_detail::clone_base | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23343288 — typeinfo for osg::NotifyHandler |
| `23344720` | boost::wrapexcept<boost::bad_function_call> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23344456 — typeinfo for boost::wrapexcept<boost::bad_function_call> |
| `23344840` | boost::wrapexcept<boost::program_options::invalid_option_value> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23344528 — typeinfo for boost::wrapexcept<boost::program_options::invalid_option_value> |
| `23344976` | boost::wrapexcept<boost::program_options::validation_error> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23344600 — typeinfo for boost::wrapexcept<boost::program_options::validation_error> |
| `23345112` | boost::detail::basic_unlockedbuf<std, basic_streambuf, <char, std, char_traits, <char>>, char> | 32 | 15 | -17 | no exact match | slot 15 (at new end (+0)): 19916728 — typeinfo name for boost::program_options::error |
| `23346128` | boost::program_options::error | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23345264 — typeinfo for boost::program_options::validation_error |
| `23346168` | boost::program_options::validation_error | 32 | 5 | -27 | yes | slot 6 (one word after new end (+1)): 23345288 — typeinfo for boost::program_options::invalid_option_value |
| `23346224` | boost::program_options::invalid_option_value | 32 | 5 | -27 | yes | slot 6 (one word after new end (+1)): 23345352 — typeinfo for boost::bad_function_call |
| `23346280` | boost::bad_function_call | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23345416 — typeinfo for boost::program_options::typed_value<std, vector, <Files::MaybeQuotedPath, std::allocator, <Files::MaybeQuotedPath>>, char> |
| `23346320` | boost::program_options::typed_value<std, vector, <Files::MaybeQuotedPath, std::allocator, <Files::MaybeQuotedPath>>, char> | 32 | 12 | -20 | no exact match | slot 13 (one word after new end (+1)): 23345416 — typeinfo for boost::program_options::typed_value<std, vector, <Files::MaybeQuotedPath, std::allocator, <Files::MaybeQuotedPath>>, char> |
| `23346472` | boost::program_options::typed_value<Files::MaybeQuotedPath, char> | 32 | 12 | -20 | yes | slot 13 (one word after new end (+1)): 23345472 — typeinfo for boost::program_options::typed_value<Files::MaybeQuotedPath, char> |
| `23346776` | boost::program_options::typed_value<std::__cxx11::basic_string<char, std, char_traits, <char>, std::allocator, <char>>, char> | 32 | 12 | -20 | no exact match | slot 13 (one word after new end (+1)): 23345584 — typeinfo for boost::program_options::typed_value<std::__cxx11::basic_string<char, std, char_traits, <char>, std::allocator, <char>>, char> |
| `23346928` | boost::program_options::typed_value<bool, char> | 32 | 12 | -20 | yes | slot 13 (one word after new end (+1)): 23345640 — typeinfo for boost::program_options::typed_value<bool, char> |
| `23347080` | boost::program_options::typed_value<int, char> | 32 | 12 | -20 | yes | slot 13 (one word after new end (+1)): 23345696 — typeinfo for boost::program_options::typed_value<int, char> |
| `23347232` | boost::program_options::typed_value<Fallback::FallbackMap, char> | 32 | 12 | -20 | yes | slot 13 (one word after new end (+1)): 23345752 — typeinfo for boost::program_options::typed_value<Fallback::FallbackMap, char> |
| `23347384` | boost::program_options::typed_value<unsigned int, char> | 32 | 12 | -20 | yes | slot 13 (one word after new end (+1)): 23345808 — typeinfo for boost::program_options::typed_value<unsigned int, char> |
| `23347664` | ICS::DetectingBindingListener | 32 | 9 | -23 | yes | slot 9 (at new end (+0)): 19918352 — typeinfo name for sol::error |
| `23497472` | DoubleBufferCallback | 32 | 0 | -32 | yes | slot 0 (at new end (+0)): 23493856 — typeinfo for DoubleBufferCallback |
| `23567880` | fx::Lexer::LexerException | 32 | 4 | -28 | yes | slot 4 (at new end (+0)): 19955824 — _ZTSMN2fx7Widgets11UniformBaseEFvPN5MyGUI6WidgetEE |
| `23568160` | fx::Widgets::EditBool | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23568000 — typeinfo for fx::Widgets::EditBool |
| `23568776` | fx::Widgets::UniformBase | 32 | 22 | -10 | yes | slot 23 (one word after new end (+1)): 23568056 — typeinfo for fx::Widgets::UniformBase |
| `23572392` | fx::StateUpdater | 32 | 0 | -32 | yes | slot 0 (at new end (+0)): 23569320 — typeinfo for fx::StateUpdater |
| `23573344` | ESM::ContainerState | 32 | 16 | -16 | yes | slot 16 (at new end (+0)): 19958712 — typeinfo name for ESM::NpcState |
| `23573504` | ESM::NpcState | 32 | 16 | -16 | yes | slot 16 (at new end (+0)): 19958728 — typeinfo name for ESM::CreatureState |
| `23573664` | ESM::CreatureState | 32 | 16 | -16 | yes | slot 16 (at new end (+0)): 19958840 — typeinfo name for ESM::CreatureLevListState |
| `23573824` | ESM::CreatureLevListState | 32 | 16 | -16 | yes | slot 16 (at new end (+0)): 19958872 — typeinfo name for ESM::DoorState |
| `23573984` | ESM::DoorState | 32 | 16 | -16 | yes | slot 16 (at new end (+0)): 19958896 — typeinfo name for Terrain::Storage |
| `23574184` | ESMTerrain::LandObject | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23574512` | ESMTerrain::Storage | 32 | 17 | -15 | yes | slot 17 (at new end (+0)): 19959520 — typeinfo name for Stereo::InitialFrustumCallback |
| `23586728` | boost::iostreams::detail::indirect_streambuf<Debug::Tee, std, char_traits, <char>, std::allocator, <char>, boost::iostreams::output> | 32 | 23 | -9 | no exact match | slot 24 (one word after new end (+1)): 23586632 — typeinfo for boost::iostreams::stream_buffer<Debug::Tee, std, char_traits, <char>, std::allocator, <char>, boost::iostreams::output> |
| `23586928` | boost::iostreams::stream_buffer<Debug::Tee, std, char_traits, <char>, std::allocator, <char>, boost::iostreams::output> | 32 | 23 | -9 | no exact match | slot 24 (one word after new end (+1)): 23586656 — _ZTIN5boost10wrapexceptINSt8ios_base7failureB5cxx11EEE |
| `23587544` | Debug::EnableGLDebugOperation | 32 | 0 | -32 | yes | slot 0 (at new end (+0)): 23587248 — typeinfo for Debug::EnableGLDebugOperation |
| `23587680` | Debug::DebugGroup | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23588144` | boost::program_options::abstract_variables_map | 32 | 4 | -28 | yes | slot 4 (at new end (+0)): 19961656 — typeinfo name for boost::program_options::error_with_no_option_name |
| `23588520` | boost::program_options::error_with_no_option_name | 32 | 5 | -27 | yes | slot 6 (one word after new end (+1)): 23588208 — typeinfo for boost::program_options::unknown_option |
| `23588576` | boost::program_options::unknown_option | 32 | 5 | -27 | yes | slot 6 (one word after new end (+1)): 23588232 — typeinfo for boost::program_options::invalid_syntax |
| `23588632` | boost::program_options::invalid_syntax | 32 | 6 | -26 | yes | slot 7 (one word after new end (+1)): 23588256 — typeinfo for boost::program_options::invalid_config_file_syntax |
| `23588696` | boost::program_options::invalid_config_file_syntax | 32 | 6 | -26 | yes | slot 7 (one word after new end (+1)): 23588280 — typeinfo for boost::wrapexcept<boost::program_options::error> |
| `23588760` | boost::wrapexcept<boost::program_options::error> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23588280 — typeinfo for boost::wrapexcept<boost::program_options::error> |
| `23588880` | boost::wrapexcept<boost::program_options::unknown_option> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23588352 — typeinfo for boost::wrapexcept<boost::program_options::unknown_option> |
| `23589016` | boost::wrapexcept<boost::program_options::invalid_config_file_syntax> | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23588424 — typeinfo for boost::wrapexcept<boost::program_options::invalid_config_file_syntax> |
| `23589224` | __cxxabiv1::__vmi_class_type_info | 32 | 4 | -28 | no exact match | slot 4 (at new end (+0)): 19962696 — _ZTSSt19_Sp_counted_deleterIPSiN5boost15program_options6detail12null_deleterESaIvELN9__gnu_cxx12_Lock_policyE2EE+0x280 |
| `23589312` | Compiler::ControlParser | 32 | 11 | -21 | yes | slot 11 (at new end (+0)): 19962800 — typeinfo name for Compiler::ErrorHandler |
| `23589424` | Compiler::ErrorHandler | 32 | 6 | -26 | yes | slot 6 (at new end (+0)): 19962832 — typeinfo name for Compiler::ExprParser |
| `23589504` | Compiler::ExprParser | 32 | 11 | -21 | yes | slot 11 (at new end (+0)): 19963200 — typeinfo name for Compiler::FileParser |
| `23589624` | Compiler::FileParser | 32 | 11 | -21 | yes | slot 11 (at new end (+0)): 19963224 — typeinfo name for Compiler::LineParser |
| `23589768` | Compiler::LineParser | 32 | 11 | -21 | yes | slot 11 (at new end (+0)): 19963808 — typeinfo name for Compiler::Parser |
| `23589928` | Compiler::ScriptParser | 32 | 11 | -21 | yes | slot 11 (at new end (+0)): 19964416 — typeinfo name for Compiler::SkipParser |
| `23590048` | Compiler::SkipParser | 32 | 11 | -21 | yes | slot 11 (at new end (+0)): 19964440 — typeinfo name for Compiler::StreamErrorHandler |
| `23590168` | Compiler::StreamErrorHandler | 32 | 6 | -26 | yes | slot 6 (at new end (+0)): 19964472 — typeinfo name for Compiler::StringParser |
| `23590248` | Compiler::StringParser | 32 | 11 | -21 | yes | slot 11 (at new end (+0)): 19964768 — typeinfo name for Compiler::DeclarationParser |
| `23590368` | Compiler::DeclarationParser | 32 | 11 | -21 | yes | slot 11 (at new end (+0)): 19965056 — typeinfo name for Compiler::QuickFileParser |
| `23590488` | Compiler::QuickFileParser | 32 | 11 | -21 | yes | slot 11 (at new end (+0)): 19965088 — typeinfo name for Compiler::DiscardParser |
| `23590608` | Compiler::DiscardParser | 32 | 11 | -21 | yes | slot 11 (at new end (+0)): 19965120 — typeinfo name for Compiler::JunkParser |
| `23590728` | Compiler::JunkParser | 32 | 11 | -21 | yes | slot 11 (at new end (+0)): 19965144 — typeinfo name for Interpreter::OpPushInt |
| `23606288` | Gui::FontWrapper<MyGUI::ComboBox> | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23607232` | Gui::FontWrapper<MyGUI::EditBox> | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23608048` | Gui::AutoSizedWidget | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23606120 — typeinfo for Gui::Spacer |
| `23608088` | Gui::Spacer | 32 | 5 | -27 | yes | slot 6 (one word after new end (+1)): 23606120 — typeinfo for Gui::Spacer |
| `23608688` | Gui::ComboBox | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23609632` | Gui::AutoSizedTextBox | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23605928 — typeinfo for Gui::AutoSizedTextBox |
| `23610336` | Gui::AutoSizedEditBox | 32 | 8 | -24 | yes | slot 9 (one word after new end (+1)): 23605984 — typeinfo for Gui::AutoSizedEditBox |
| `23611232` | Gui::AutoSizedButton | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23606040 — typeinfo for Gui::AutoSizedButton |
| `23611984` | Gui::Box | 32 | 5 | -27 | yes | slot 6 (one word after new end (+1)): 23606176 — typeinfo for Gui::HBox |
| `23612040` | Gui::HBox | 32 | 12 | -20 | yes | slot 13 (one word after new end (+1)): 23606176 — typeinfo for Gui::HBox |
| `23612696` | Gui::VBox | 32 | 12 | -20 | yes | slot 13 (one word after new end (+1)): 23606232 — typeinfo for Gui::VBox |
| `23613376` | Gui::ImageButton | 32 | 28 | -4 | yes | slot 29 (one word after new end (+1)): 23613352 — typeinfo for Gui::ImageButton |
| `23614152` | Gui::MWList | 32 | 22 | -10 | yes | slot 23 (one word after new end (+1)): 23614048 — typeinfo for Gui::MWList |
| `23614800` | Gui::NumericEditBox | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23615640` | Gui::SharedStateButton | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23616320` | Gui::Button | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23617000` | Gui::TextBox | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23617632` | Gui::EditBox | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23619336` | LuaUi::LuaWidget | 32 | 22 | -10 | yes | slot 23 (one word after new end (+1)): 23619280 — typeinfo for LuaUi::LuaWidget |
| `23620024` | LuaUi::LuaAdapter | 32 | 22 | -10 | yes | slot 23 (one word after new end (+1)): 23260864 — typeinfo for LuaUi::LuaAdapter |
| `23620568` | __cxxabiv1::__class_type_info | 32 | 1 | -31 | no exact match | slot 1 (at new end (+0)): 19972592 — typeinfo name for LuaUi::LuaText |
| `23620640` | LuaUi::LuaText | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23621712` | LuaUi::LuaTextEdit | 32 | 28 | -4 | yes | slot 29 (one word after new end (+1)): 23621616 — typeinfo for LuaUi::LuaTextEdit |
| `23622536` | LuaUi::LuaWindow | 32 | 24 | -8 | yes | slot 25 (one word after new end (+1)): 23622440 — typeinfo for LuaUi::LuaWindow |
| `23623296` | LuaUi::LuaTileRect | 32 | 20 | -12 | yes | slot 21 (one word after new end (+1)): 23623216 — typeinfo for LuaUi::LuaTileRect |
| `23623520` | LuaUi::LuaImage | 32 | 24 | -8 | yes | slot 25 (one word after new end (+1)): 23623240 — typeinfo for LuaUi::LuaImage |
| `23624232` | LuaUi::LuaContainer | 32 | 14 | -18 | yes | slot 15 (one word after new end (+1)): 23624176 — typeinfo for LuaUi::LuaContainer |
| `23624960` | LuaUi::LuaFlex | 32 | 27 | -5 | yes | slot 28 (one word after new end (+1)): 23624904 — typeinfo for LuaUi::LuaFlex |
| `23625664` | DetourNavigator::NavigatorException | 32 | 4 | -28 | yes | slot 4 (at new end (+0)): 19973576 — typeinfo name for DetourNavigator::InvalidArgument |
| `23625752` | DetourNavigator::InvalidArgument | 32 | 4 | -28 | yes | slot 4 (at new end (+0)): 19973856 — _ZTSSt23_Sp_counted_ptr_inplaceIN15DetourNavigator10RecastMeshESaIvELN9__gnu_cxx12_Lock_policyE2EE+0xF0 |
| `23626792` | Bsa::MemoryInputStream | 32 | 0 | -32 | yes | slot 0 (at new end (+0)): 23626192 — typeinfo for Bsa::MemoryInputStream |
| `23627008` | Bsa::CompressedBSAFile | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 23626328 — typeinfo for boost::iostreams::detail::chainbuf<boost::iostreams::chain<boost::iostreams::input, char, std, char_traits, <char>, std::allocator, <char>>, boost::iostreams::input, boost::iostreams::public_> |
| `23627056` | boost::iostreams::detail::chainbuf<boost::iostreams::chain<boost::iostreams::input, char, std, char_traits, <char>, std::allocator, <char>>, boost::iostreams::input, boost::iostreams::public_> | 32 | 14 | -18 | no exact match | slot 15 (one word after new end (+1)): 23626328 — typeinfo for boost::iostreams::detail::chainbuf<boost::iostreams::chain<boost::iostreams::input, char, std, char_traits, <char>, std::allocator, <char>>, boost::iostreams::input, boost::iostreams::public_> |
| `23627224` | boost::iostreams::filtering_streambuf<boost::iostreams::input, char, std, char_traits, <char>, std::allocator, <char>, boost::iostreams::public_> | 32 | 14 | -18 | no exact match | slot 15 (one word after new end (+1)): 23626400 — typeinfo for boost::iostreams::filtering_streambuf<boost::iostreams::input, char, std, char_traits, <char>, std::allocator, <char>, boost::iostreams::public_> |
| `23627472` | boost::iostreams::detail::indirect_streambuf<boost::iostreams::basic_zlib_decompressor<std::allocator, <char>>, std, char_traits, <char>, boost::iostreams::basic_zlib_decompressor<std::allocator, <char>>, boost::iostreams::input> | 32 | 23 | -9 | no exact match | slot 24 (one word after new end (+1)): 23626472 — typeinfo for boost::iostreams::stream_buffer<boost::iostreams::basic_zlib_decompressor<std::allocator, <char>>, std, char_traits, <char>, boost::iostreams::basic_zlib_decompressor<std::allocator, <char>>, boost::iostreams::input> |
| `23627672` | boost::iostreams::stream_buffer<boost::iostreams::basic_zlib_decompressor<std::allocator, <char>>, std, char_traits, <char>, boost::iostreams::basic_zlib_decompressor<std::allocator, <char>>, boost::iostreams::input> | 32 | 23 | -9 | no exact match | slot 24 (one word after new end (+1)): 23626496 — typeinfo for boost::iostreams::detail::indirect_streambuf<boost::iostreams::detail::mode_adapter<boost::iostreams::input, std::istream>, std, char_traits, <char>, std::allocator, <char>, boost::iostreams::input> |
| `23627872` | boost::iostreams::detail::indirect_streambuf<boost::iostreams::detail::mode_adapter<boost::iostreams::input, std::istream>, std, char_traits, <char>, std::allocator, <char>, boost::iostreams::input> | 32 | 23 | -9 | no exact match | slot 24 (one word after new end (+1)): 23626520 — typeinfo for boost::iostreams::stream_buffer<boost::iostreams::detail::mode_adapter<boost::iostreams::input, std::istream>, std, char_traits, <char>, std::allocator, <char>, boost::iostreams::input> |
| `23628072` | boost::iostreams::stream_buffer<boost::iostreams::detail::mode_adapter<boost::iostreams::input, std::istream>, std, char_traits, <char>, std::allocator, <char>, boost::iostreams::input> | 32 | 23 | -9 | no exact match | slot 24 (one word after new end (+1)): 23626568 — typeinfo for boost::wrapexcept<std, logic_error> |
| `23628272` | boost::wrapexcept<std, logic_error> | 32 | 4 | -28 | no exact match | slot 5 (one word after new end (+1)): 23626568 — typeinfo for boost::wrapexcept<std, logic_error> |
| `23628392` | boost::iostreams::detail::indirect_streambuf<boost::iostreams::basic_null_device<char, boost::iostreams::input>, std, char_traits, <char>, std::allocator, <char>, boost::iostreams::input> | 32 | 23 | -9 | no exact match | slot 24 (one word after new end (+1)): 23626688 — typeinfo for boost::iostreams::stream_buffer<boost::iostreams::basic_null_device<char, boost::iostreams::input>, std, char_traits, <char>, std::allocator, <char>, boost::iostreams::input> |
| `23628592` | boost::iostreams::stream_buffer<boost::iostreams::basic_null_device<char, boost::iostreams::input>, std, char_traits, <char>, std::allocator, <char>, boost::iostreams::input> | 32 | 24 | -8 | no exact match | slot 24 (at new end (+0)): 19978760 — typeinfo name for VFS::File |
| `23634088` | Files::ConstrainedFileStreamBuf | 32 | 15 | -17 | yes | slot 15 (at new end (+0)): 19982632 — typeinfo name for Terrain::TerrainDrawable |
| `23635040` | Gui::WindowCaption | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `23636416` | __cxxabiv1::__si_class_type_info | 32 | 2 | -30 | no exact match | slot 2 (at new end (+0)): 19985016 — _ZTSSt23_Sp_counted_ptr_inplaceIN15DetourNavigator23CachedRecastMeshManagerESaIvELN9__gnu_cxx12_Lock_policyE2EE |
| `23654656` | btHeightfieldTerrainShape | 32 | 1 | -31 | yes | slot 1 (at new end (+0)): 23517184 — typeinfo for Nif::BSShaderProperty |
| `23655072` | boost::program_options::variables_map | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 23090520 — typeinfo for MWRender::Animation |
| `23655496` | icu_74::ErrorCode | 32 | 8 | -24 | yes | slot 9 (one word after new end (+1)): 23631656 — typeinfo for Nif::NiParticleModifier |
| `23655640` | btSphereShape | 32 | 21 | -11 | yes | slot 21 (at new end (+0)): 23633288 — typeinfo for Nif::NiPosData |
| `23656000` | btConvexInternalShape | 32 | 0 | -32 | yes | slot 0 (at new end (+0)): 23633312 — typeinfo for Nif::NiUVData |
| `23656728` | boost::program_options::error_with_option_name | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 23633408 — typeinfo for Nif::NiVisData |
| `23656984` | icu_74::UnicodeString | 32 | 2 | -30 | yes | slot 3 (one word after new end (+1)): 23632952 — typeinfo for Nif::NiNode |
| `23657080` | btBoxShape | 32 | 1 | -31 | yes | slot 2 (one word after new end (+1)): 23620584 — typeinfo for LuaUi::LuaText |

Retained target audit: 1291 target addresses compared; 0 missing and 0 changed addresses inside the final slot range; 126 labels differ while the target address stays equal. Oracle owner-name matches among changed tables: 165/202; unmatched names remain unverified by this sidecar.

### openttd

The staged scan and saved result each cover 300/300 sampled classes. Recorded vtable addresses: 73 old / 73 final; shared 73. Changed 68, unchanged 5, increased 0, old-only 0, final-only 0. Slot sum 2305 → 919 (-1386). Immediate RTTI boundary offsets: {"0":42,"1":26}.

| vtable address | result class label | old slots | final slots | Δ | owner in oracle class list | first post-end RTTI evidence |
|---:|---|---:|---:|---:|:---:|---|
| `9548712` | GameScannerLibrary | 32 | 9 | -23 | yes | slot 10 (one word after new end (+1)): 9549168 — typeinfo for GameScannerInfo |
| `9548800` | GameScannerInfo | 32 | 9 | -23 | yes | slot 10 (one word after new end (+1)): 9549192 — typeinfo for AIScannerLibrary |
| `9548888` | AIScannerLibrary | 32 | 9 | -23 | yes | slot 10 (one word after new end (+1)): 9549216 — typeinfo for AIScannerInfo |
| `9548976` | AIScannerInfo | 32 | 9 | -23 | yes | slot 10 (one word after new end (+1)): 9550096 — typeinfo for FiosFileScanner |
| `9549064` | FiosFileScanner | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 9550120 — typeinfo for TarScanner |
| `9549712` | HouseScopeResolver | 32 | 6 | -26 | yes | slot 7 (one word after new end (+1)): 9550352 — typeinfo for GenericScopeResolver |
| `9549776` | GenericScopeResolver | 32 | 6 | -26 | yes | slot 7 (one word after new end (+1)): 9550376 — typeinfo for VehicleScopeResolver |
| `9549904` | CanalScopeResolver | 32 | 6 | -26 | yes | slot 7 (one word after new end (+1)): 9550424 — typeinfo for AirportTileScopeResolver |
| `9549968` | AirportTileScopeResolver | 32 | 6 | -26 | yes | slot 7 (one word after new end (+1)): 9550448 — typeinfo for AirportScopeResolver |
| `9550032` | AirportScopeResolver | 32 | 7 | -25 | yes | slot 7 (at new end (+0)): 7979680 — typeinfo name for FiosFileScanner |
| `9550608` | GRFFileScanner | 32 | 4 | -28 | yes | slot 4 (at new end (+0)): 7980096 — typeinfo name for IndustryTileScopeResolver |
| `9550736` | DiagonalTileIterator | 32 | 5 | -27 | yes | slot 5 (at new end (+0)): 7980136 — typeinfo name for DiagonalTileIterator |
| `9550912` | ClientNetworkUDPSocketHandler | 32 | 4 | -28 | yes | slot 5 (one word after new end (+1)): 9551824 — typeinfo for ServerNetworkUDPSocketHandler |
| `9551128` | ClientNetworkTurnSocketHandler | 32 | 8 | -24 | yes | slot 9 (one word after new end (+1)): 9552896 — typeinfo for ClientNetworkStunSocketHandler |
| `9551208` | ClientNetworkStunSocketHandler | 32 | 6 | -26 | yes | slot 7 (one word after new end (+1)): 9552984 — typeinfo for ClientNetworkCoordinatorSocketHandler |
| `9551272` | ClientNetworkCoordinatorSocketHandler | 32 | 22 | -10 | yes | slot 23 (one word after new end (+1)): 9553232 — typeinfo for ServerNetworkAdminSocketHandler |
| `9556168` | AIInstance | 32 | 8 | -24 | yes | slot 9 (one word after new end (+1)): 9558832 — typeinfo for ClientNetworkContentSocketHandler |
| `9556248` | ClientNetworkContentSocketHandler | 32 | 19 | -13 | yes | slot 20 (one word after new end (+1)): 9558832 — typeinfo for ClientNetworkContentSocketHandler |
| `9556768` | GRFConfig | 32 | 2 | -30 | yes | slot 3 (one word after new end (+1)): 9559864 — typeinfo for GRFFile |
| `9556800` | GRFFile | 32 | 2 | -30 | yes | slot 3 (one word after new end (+1)): 9559888 — typeinfo for OpenGLBackend |
| `9557432` | ClientNetworkGameSocketHandler | 32 | 30 | -2 | yes | slot 31 (one word after new end (+1)): 9560024 — typeinfo for ClientNetworkGameSocketHandler |
| `9558240` | AIConfig | 32 | 8 | -24 | yes | slot 9 (one word after new end (+1)): 9560152 — typeinfo for SQTable |
| `9558488` | Blitter_32bppAnim | 32 | 24 | -8 | yes | slot 24 (at new end (+0)): 7981808 — typeinfo name for AIInstance |
| `9560792` | GameConfig | 32 | 9 | -23 | yes | slot 9 (at new end (+0)): 7982800 — typeinfo name for ScriptConfig |
| `9562536` | BaseVehicleListWindow | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `9564512` | Blitter_Null | 32 | 24 | -8 | yes | slot 24 (at new end (+0)): 7983072 — typeinfo name for Blitter_40bppAnim |
| `9564736` | Blitter_40bppAnim | 32 | 24 | -8 | yes | slot 24 (at new end (+0)): 7983096 — typeinfo name for Blitter_8bppSimple |
| `9564960` | Blitter_8bppSimple | 32 | 24 | -8 | yes | slot 24 (at new end (+0)): 7983120 — typeinfo name for Blitter_8bppOptimized |
| `9565184` | Blitter_8bppOptimized | 32 | 24 | -8 | yes | slot 24 (at new end (+0)): 7983144 — typeinfo name for Blitter_8bppBase |
| `9565408` | Blitter_8bppBase | 32 | 24 | -8 | yes | slot 24 (at new end (+0)): 7983168 — typeinfo name for Blitter_32bppSimple |
| `9565632` | Blitter_32bppSimple | 32 | 24 | -8 | yes | slot 24 (at new end (+0)): 7983192 — typeinfo name for Blitter_32bppOptimized |
| `9565856` | Blitter_32bppOptimized | 32 | 24 | -8 | yes | slot 24 (at new end (+0)): 7983224 — typeinfo name for Blitter_32bppBase |
| `9566080` | Blitter_32bppBase | 32 | 24 | -8 | yes | slot 24 (at new end (+0)): 7983248 — typeinfo name for GameInstance |
| `9566304` | GameInstance | 32 | 9 | -23 | yes | slot 9 (at new end (+0)): 7983264 — typeinfo name for TCPServerConnecter |
| `9566592` | BaseNetworkContentDownloadStatusWindow | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `9567392` | 13GroundVehicleI11RoadVehicleL11VehicleType1EE | 32 | 23 | -9 | no exact match | slot 23 (at new end (+0)): 7983416 — _ZTS13GroundVehicleI5TrainL11VehicleType0EE |
| `9567608` | 13GroundVehicleI5TrainL11VehicleType0EE | 32 | 23 | -9 | no exact match | slot 23 (at new end (+0)): 7983456 — typeinfo name for EffectVehicle |
| `9567824` | EffectVehicle | 32 | 23 | -9 | yes | slot 23 (at new end (+0)): 7983472 — typeinfo name for DisasterVehicle |
| `9568040` | DisasterVehicle | 32 | 23 | -9 | yes | slot 23 (at new end (+0)): 7983496 — typeinfo name for ChunkHandler |
| `9568248` | ChunkHandler | 32 | 7 | -25 | yes | slot 7 (at new end (+0)): 7983512 — typeinfo name for NewGRFMappingChunkHandler |
| `9569760` | BaseSettingEntry | 32 | 15 | -17 | yes | slot 15 (at new end (+0)): 7983696 — typeinfo name for SettingEntry |
| `9570136` | GameLibrary | 32 | 8 | -24 | yes | slot 8 (at new end (+0)): 7983752 — typeinfo name for GameInfo |
| `9570232` | GameInfo | 32 | 8 | -24 | yes | slot 8 (at new end (+0)): 7983768 — typeinfo name for AILibrary |
| `9570328` | AILibrary | 32 | 8 | -24 | yes | slot 8 (at new end (+0)): 7983784 — typeinfo name for AIInfo |
| `9570424` | AIInfo | 32 | 8 | -24 | yes | slot 8 (at new end (+0)): 7983792 — typeinfo name for ScriptInfo |
| `9571176` | fmt::v7::system_error | 32 | 3 | -29 | yes | slot 4 (one word after new end (+1)): 9571096 — typeinfo for fmt::v7::format_error |
| `9571216` | fmt::v7::format_error | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `9572896` | DropDownListIconItem | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 9573264 — typeinfo for SpriteFontCache |
| `9573096` | DropDownListCharStringItem | 32 | 7 | -25 | yes | slot 8 (one word after new end (+1)): 9573440 — typeinfo for DropDownListParamStringItem |
| `9573168` | DropDownListParamStringItem | 32 | 8 | -24 | yes | slot 8 (at new end (+0)): 8000736 — typeinfo name for DropDownListIconItem |
| `9573288` | FontCache | 32 | 15 | -17 | yes | slot 15 (at new end (+0)): 8000784 — typeinfo name for DropDownListCharStringItem |
| `9573464` | DropDownListStringItem | 32 | 8 | -24 | yes | slot 8 (at new end (+0)): 8000864 — typeinfo name for DropDownListStringItem |
| `9573616` | FreeTypeFontCache | 32 | 17 | -15 | yes | slot 17 (at new end (+0)): 8000936 — typeinfo name for TrueTypeFontCache |
| `9573944` | DriverFactoryBase | 32 | 5 | -27 | yes | slot 5 (at new end (+0)): 8000984 — typeinfo name for BoolSettingDesc |
| `9574016` | BoolSettingDesc | 32 | 10 | -22 | yes | slot 10 (at new end (+0)): 8001008 — typeinfo name for DropDownListItem |
| `9574120` | DropDownListItem | 32 | 7 | -25 | yes | slot 7 (at new end (+0)): 8001032 — typeinfo name for IntSettingDesc |
| `9575080` | BaseStation | 32 | 10 | -22 | yes | slot 10 (at new end (+0)): 8001408 — _ZTSN4PoolI11BaseStationtLm32ELm64000EL8PoolType1ELb0ELb1EE8PoolItemIXadL_Z13_station_poolEEEE |
| `9577312` | Aircraft | 32 | 23 | -9 | yes | slot 23 (at new end (+0)): 8002512 — typeinfo name for ScriptTownEffectList |
| `9577664` | FallbackParagraphLayout | 32 | 5 | -27 | yes | slot 5 (at new end (+0)): 8002728 — typeinfo name for ScriptTileList |
| `9581464` | FallbackParagraphLayout::FallbackVisualRun | 32 | 9 | -23 | yes | slot 9 (at new end (+0)): 8002928 — typeinfo name for ScriptWaypointList_Vehicle |
| `9587120` | HouseResolverObject | 32 | 6 | -26 | yes | slot 7 (one word after new end (+1)): 9587688 — typeinfo for VehicleResolverObject |
| `9587248` | CargoResolverObject | 32 | 6 | -26 | yes | slot 7 (one word after new end (+1)): 9587736 — typeinfo for CanalResolverObject |
| `9587312` | CanalResolverObject | 32 | 6 | -26 | yes | slot 7 (one word after new end (+1)): 9587760 — typeinfo for AirportTileResolverObject |
| `9587376` | AirportTileResolverObject | 32 | 6 | -26 | yes | slot 7 (one word after new end (+1)): 9587784 — typeinfo for AirportResolverObject |
| `9587440` | AirportResolverObject | 32 | 7 | -25 | yes | slot 7 (at new end (+0)): 8004920 — _ZTSN4PoolI11SpriteGroupjLm1024ELm1073741824EL8PoolType8ELb0ELb1EE8PoolItemIXadL_Z17_spritegroup_poolEEEE |
| `9588048` | DeterministicSpriteGroup | 32 | 7 | -25 | yes | slot 7 (at new end (+0)): 8005448 — typeinfo name for ResolverObject |
| `9590408` | FlowMapper | 32 | 4 | -28 | yes | slot 4 (at new end (+0)): 8006360 — typeinfo name for HeaderWriter |
| `9597776` | CrashLog | 32 | 10 | -22 | yes | slot 10 (at new end (+0)): 8009320 — typeinfo name for CrashLog |
| `9598976` | BasePersistentStorageArray | 32 | 4 | -28 | yes | slot 4 (at new end (+0)): 8009640 — typeinfo name for BasePersistentStorageArray |
| `9629272` | FallbackParagraphLayout::FallbackLine | 32 | 32 | 0 | yes | unchanged / no boundary difference |
| `9656008` | __cxxabiv1::__class_type_info | 32 | 32 | 0 | no exact match | unchanged / no boundary difference |
| `9660240` | __cxxabiv1::__vmi_class_type_info | 32 | 1 | -31 | no exact match | slot 1 (at new end (+0)): 9562056 — typeinfo for Window |
| `9673936` | __cxxabiv1::__si_class_type_info | 1 | 0 | -1 | no exact match | slot 0 (at new end (+0)): 9568312 — typeinfo for NewGRFMappingChunkHandler |

Retained target audit: 818 target addresses compared; 0 missing and 0 changed addresses inside the final slot range; 0 labels differ while the target address stays equal. Oracle owner-name matches among changed tables: 64/68; unmatched names remain unverified by this sidecar.

## Indirect-call marker losses by function address

The aa4e column reports the intermediate run used by the earlier lane; the final 3180 column is the requested latest artifact. `n/s` means the function address is absent from that run’s 20-row `decompiled` sample. A zero marker count alone is not a resolved virtual target. The saved result excerpt is truncated where shown; the table does not infer hidden call text.

### openmw

Aggregate marker totals: c34d 5 → aa4e 0 → final 3180 0. Shared decompiled addresses: 7/20.

| function address | function label | c34d markers | aa4e markers / call evidence | final markers / call evidence |
|---:|---|---:|---|---|
| `14816704` | boost::any::holder<Fallback::FallbackMap>::~<Fallback::FallbackMap>() | 1 | 0; unknown_call visible; no proven virtual target | 0; target not proven; excerpt truncated (400/1608 chars) |
| `18559072` | LuaUi::LuaText::~LuaText() | 2 | n/s; not sampled; no call-level conclusion | n/s; not sampled; no call-level conclusion |
| `18561520` | LuaUi::LuaText::~LuaText() | 2 | n/s; not sampled; no call-level conclusion | n/s; not sampled; no call-level conclusion |

### openttd

Aggregate marker totals: c34d 4 → aa4e 2 → final 3180 1. Shared decompiled addresses: 19/20.

| function address | function label | c34d markers | aa4e markers / call evidence | final markers / call evidence |
|---:|---|---:|---|---|
| `2607552` | AIInfo::~AIInfo() | 1 | 0; unknown_call visible; no proven virtual target | 0; target not proven; excerpt truncated (400/591 chars) |
| `2607696` | AILibrary::~AILibrary() | 1 | 0; unknown_call visible; no proven virtual target | 0; target not proven; excerpt truncated (400/597 chars) |
| `7431668` | Window::FindWindowPlacementAndResize(int, int) | 2 | 2; marker count retained; no marker loss | 1; target not proven; excerpt truncated (400/3527 chars) |

## Provenance and limitations

| game | old SHA-256 | final SHA-256 | oracle dynamic counts old/final | oracle class names | debug/DWARF |
|---|---|---|---|---:|---|
| openmw | `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db` | `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db` | vtables 1847/1847, typeinfos 2564/2564 | 2606 identical names | unavailable, 0 classes / 0 members |
| openttd | `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5` | `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5` | vtables 200/200, typeinfos 354/354 | 365 identical names | unavailable, 0 classes / 0 members |

The independent sidecars prove the same binary build and provide an independently produced class-name set and dynamic RTTI counts. They do not contain per-address vtable extents, and the debug sidecars are empty because DWARF is unavailable. Therefore the address-level boundary evidence is the old per-slot target record plus the final emitted count, not an independent debug-symbol slot oracle. The final artifacts retain only 400-character excerpts for many longer decompiles, so the marker target status is unknown where the full call text is not saved.

## Analysis checks

`node /mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924/cxxcmp/compare-addresses.mjs` — PASS 42, FAIL 0. Checks are structural assertions over the supplied artifacts; they do not execute product tests.

- PASS — openmw: baseline and final result each contain the reported 300-class sample
- PASS — openmw: baseline per-address slot sum equals totals.vtableSlots
- PASS — openmw: final per-address slot sum equals totals.vtableSlots
- PASS — openmw: every recorded vtable address is present on both sides
- PASS — openmw: no recorded vtable address increases its slot count
- PASS — openmw: no resolved target address disappears or changes within the retained slot range
- PASS — openmw: every changed table has an immediate RTTI marker at the new end or one word after it
- PASS — openmw: stages.json records the same 300-class vtable scan sample
- PASS — openmw: both old baseline runs have identical per-address slot and target-address records
- PASS — openmw: both aa4e runs have identical per-address slot and target-address records
- PASS — openmw: both 3180 runs have identical per-address slot and target-address records
- PASS — openmw: aa4e and final 3180 have identical per-address slot and target-address records
- PASS — openmw: every final resolved target slot is matched to the same old address
- PASS — openttd: baseline and final result each contain the reported 300-class sample
- PASS — openttd: baseline per-address slot sum equals totals.vtableSlots
- PASS — openttd: final per-address slot sum equals totals.vtableSlots
- PASS — openttd: every recorded vtable address is present on both sides
- PASS — openttd: no recorded vtable address increases its slot count
- PASS — openttd: no resolved target address disappears or changes within the retained slot range
- PASS — openttd: every changed table has an immediate RTTI marker at the new end or one word after it
- PASS — openttd: stages.json records the same 300-class vtable scan sample
- PASS — openttd: both old baseline runs have identical per-address slot and target-address records
- PASS — openttd: both aa4e runs have identical per-address slot and target-address records
- PASS — openttd: both 3180 runs have identical per-address slot and target-address records
- PASS — openttd: aa4e and final 3180 have identical per-address slot and target-address records
- PASS — openttd: every final resolved target slot is matched to the same old address
- PASS — openmw: old result artifacts bind the expected c34d baseline SHA
- PASS — openmw: intermediate artifacts bind the expected aa4e SHA
- PASS — openmw: final artifacts bind the expected 3180 SHA
- PASS — openmw: independent oracle confirms old and final artifacts are the same binary build
- PASS — openmw: independent dynamic oracle counts are unchanged
- PASS — openmw: oracle.json is identical from old to final
- PASS — openmw: oracle class/DWARF/symbol sidecar bytes are identical old to final
- PASS — openttd: old result artifacts bind the expected c34d baseline SHA
- PASS — openttd: intermediate artifacts bind the expected aa4e SHA
- PASS — openttd: final artifacts bind the expected 3180 SHA
- PASS — openttd: independent oracle confirms old and final artifacts are the same binary build
- PASS — openttd: independent dynamic oracle counts are unchanged
- PASS — openttd: oracle.json is identical from old to final
- PASS — openttd: oracle class/DWARF/symbol sidecar bytes are identical old to final
- PASS — OpenMW marker totals reproduce 5 → 0 → 0 across baseline, aa4e, and final
- PASS — OpenTTD marker totals reproduce 4 → 2 → 1; final run differs from the earlier 2-marker report
